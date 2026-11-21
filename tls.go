package main

// HTTPS for the local network without any setup: on first start we create a
// small local certificate authority (CA) and use it to sign a certificate for
// this computer's hostname and network addresses. Phones only need to trust
// the CA once; the server certificate is re-issued automatically whenever the
// computer's addresses change.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type localCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

// loadOrCreateCA reads the CA from dir, creating it if it doesn't exist yet.
func loadOrCreateCA(dir string) (*localCA, error) {
	certPath := filepath.Join(dir, "ca.pem")
	keyPath := filepath.Join(dir, "ca-key.pem")

	ca, err := loadCA(certPath, keyPath)
	if err == nil {
		return ca, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("load CA: %w", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	name := "Piggy Bank Local CA"
	if h, err := os.Hostname(); err == nil && h != "" {
		name += " (" + h + ")"
	}
	tmpl := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: name, Organization: []string{"Piggy Bank"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o600); err != nil {
		return nil, err
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &localCA{cert: cert, key: key}, nil
}

func loadCA(certPath, keyPath string) (*localCA, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	certBlock, _ := pem.Decode(certPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if certBlock == nil || keyBlock == nil {
		return nil, fmt.Errorf("%s or %s is not valid PEM", certPath, keyPath)
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, err
	}
	return &localCA{cert: cert, key: key}, nil
}

// serverCert returns a certificate for the given names and IPs signed by the
// CA, reusing the one in dir if it still covers everything.
func (ca *localCA) serverCert(dir string, names []string, ips []net.IP) (tls.Certificate, error) {
	certPath := filepath.Join(dir, "server.pem")
	keyPath := filepath.Join(dir, "server-key.pem")

	if c, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if leaf, err := x509.ParseCertificate(c.Certificate[0]); err == nil && ca.covers(leaf, names, ips) {
			return c, nil
		}
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: randomSerial(),
		Subject:      pkix.Name{CommonName: "Piggy Bank", Organization: []string{"Piggy Bank"}},
		DNSNames:     names,
		IPAddresses:  ips,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(0, 0, 397), // Apple rejects longer-lived server certs
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.LoadX509KeyPair(certPath, keyPath)
}

func (ca *localCA) covers(leaf *x509.Certificate, names []string, ips []net.IP) bool {
	if leaf.CheckSignatureFrom(ca.cert) != nil || time.Until(leaf.NotAfter) < 30*24*time.Hour {
		return false
	}
	for _, n := range names {
		if !slices.Contains(leaf.DNSNames, n) {
			return false
		}
	}
	for _, ip := range ips {
		if !slices.ContainsFunc(leaf.IPAddresses, ip.Equal) {
			return false
		}
	}
	return true
}

// localAddresses lists the hostnames and IPs this computer can be reached by.
func localAddresses() (names []string, ips []net.IP) {
	names = []string{"localhost"}
	if h, err := os.Hostname(); err == nil && h != "" {
		h = strings.ToLower(h)
		names = append(names, h)
		if !strings.Contains(h, ".") {
			names = append(names, h+".local") // mDNS name, e.g. on phones
		}
	}
	ips = []net.IP{net.ParseIP("127.0.0.1"), net.IPv6loopback}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() || ipnet.IP.IsMulticast() {
			continue
		}
		ip := ipnet.IP
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		ips = append(ips, ip)
	}
	return names, ips
}

func randomSerial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return n
}

func writePEM(path, blockType string, der []byte, perm os.FileMode) error {
	data := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	return os.WriteFile(path, data, perm)
}
