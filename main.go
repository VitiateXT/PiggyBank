// Piggy Bank: a tiny web app that fills a piggy bank with euros as you save.
package main

import (
	"crypto/tls"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed static
var staticFiles embed.FS

const (
	defaultMonthlyGoalCents = 100_000         // 1,000.00 €
	maxCents                = 100_000_000_000 // 1,000,000,000.00 €
)

// Money is stored in euro cents so totals never pick up floating point drift.
type deposit struct {
	Cents int64     `json:"cents"`
	At    time.Time `json:"at"`
}

type state struct {
	MonthlyGoalCents int64     `json:"monthly_goal_cents"`
	Deposits         []deposit `json:"deposits"`
}

// clientError is an error caused by bad input; it is reported as HTTP 400.
type clientError string

func (e clientError) Error() string { return string(e) }

type store struct {
	mu    sync.Mutex
	path  string
	state state
}

func openStore(path string) (*store, error) {
	s := &store{path: path, state: state{MonthlyGoalCents: defaultMonthlyGoalCents}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if s.state.MonthlyGoalCents <= 0 {
		s.state.MonthlyGoalCents = defaultMonthlyGoalCents
	}
	return s, nil
}

func (s *store) snapshot() state {
	s.mu.Lock()
	defer s.mu.Unlock()
	return state{MonthlyGoalCents: s.state.MonthlyGoalCents, Deposits: slices.Clone(s.state.Deposits)}
}

// update applies fn to a copy of the state and saves it. The in-memory state
// only changes once the file has been written successfully.
func (s *store) update(fn func(*state) error) (state, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := state{MonthlyGoalCents: s.state.MonthlyGoalCents, Deposits: slices.Clone(s.state.Deposits)}
	if err := fn(&next); err != nil {
		return state{}, err
	}
	if err := writeFileAtomic(s.path, next); err != nil {
		return state{}, err
	}
	s.state = next
	return next, nil
}

func writeFileAtomic(path string, st state) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".piggybank-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename succeeded
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// stateView is what the browser receives. The browser works out "this month"
// itself so the month boundary follows the phone's clock.
type stateView struct {
	MonthlyGoalCents int64     `json:"monthly_goal_cents"`
	TotalCents       int64     `json:"total_cents"`
	Deposits         []deposit `json:"deposits"`
}

func toView(st state) stateView {
	v := stateView{MonthlyGoalCents: st.MonthlyGoalCents, Deposits: st.Deposits}
	if v.Deposits == nil {
		v.Deposits = []deposit{}
	}
	for _, d := range st.Deposits {
		v.TotalCents += d.Cents
	}
	return v
}

func validCents(c *int64, field string) (int64, error) {
	switch {
	case c == nil:
		return 0, clientError(field + " is required")
	case *c < 1:
		return 0, clientError(field + " must be at least 1 cent")
	case *c > maxCents:
		return 0, clientError("whoa, that's too much money for one piggy")
	}
	return *c, nil
}

// ---- HTTP ----

type server struct {
	store *store
	caDER []byte // local CA certificate offered for download; nil with -cert/-key
}

func (a *server) routes(static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	if a.caDER != nil {
		mux.HandleFunc("GET /ca.crt", a.serveCA)
	}
	mux.HandleFunc("GET /api/state", a.getState)
	mux.HandleFunc("POST /api/deposits", a.addDeposit)
	mux.HandleFunc("DELETE /api/deposits/last", a.undoDeposit)
	mux.HandleFunc("DELETE /api/deposits", a.resetDeposits)
	mux.HandleFunc("PUT /api/settings", a.putSettings)
	return mux
}

func (a *server) getState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, toView(a.store.snapshot()))
}

func (a *server) addDeposit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cents *int64 `json:"cents"`
	}
	if err := decode(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	cents, err := validCents(body.Cents, "cents")
	if err != nil {
		writeError(w, err)
		return
	}
	st, err := a.store.update(func(s *state) error {
		s.Deposits = append(s.Deposits, deposit{Cents: cents, At: time.Now()})
		return nil
	})
	respond(w, st, err)
}

func (a *server) undoDeposit(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.update(func(s *state) error {
		if len(s.Deposits) == 0 {
			return clientError("nothing to undo")
		}
		s.Deposits = s.Deposits[:len(s.Deposits)-1]
		return nil
	})
	respond(w, st, err)
}

func (a *server) resetDeposits(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.update(func(s *state) error {
		s.Deposits = nil
		return nil
	})
	respond(w, st, err)
}

func (a *server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MonthlyGoalCents *int64 `json:"monthly_goal_cents"`
	}
	if err := decode(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	goal, err := validCents(body.MonthlyGoalCents, "monthly goal")
	if err != nil {
		writeError(w, err)
		return
	}
	st, err := a.store.update(func(s *state) error {
		s.MonthlyGoalCents = goal
		return nil
	})
	respond(w, st, err)
}

// serveCA lets phones and tablets download and trust the local CA.
func (a *server) serveCA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="piggybank-ca.crt"`)
	w.Write(a.caDER)
}

// redirectHandler serves plain HTTP: the CA download (so a phone can fetch it
// before trusting HTTPS) and a redirect to HTTPS for everything else.
func (a *server) redirectHandler(httpsPort string) http.Handler {
	mux := http.NewServeMux()
	if a.caDER != nil {
		mux.HandleFunc("GET /ca.crt", a.serveCA)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		target := "https://" + net.JoinHostPort(host, httpsPort)
		if httpsPort == "443" {
			target = "https://" + host
			if strings.Contains(host, ":") {
				target = "https://[" + host + "]"
			}
		}
		http.Redirect(w, r, target+r.URL.RequestURI(), http.StatusFound)
	})
	return mux
}

func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return clientError("invalid request body")
	}
	return nil
}

func respond(w http.ResponseWriter, st state, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toView(st))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, err error) {
	var ce clientError
	if errors.As(err, &ce) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": ce.Error()})
		return
	}
	log.Printf("error: %v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "couldn't save your piggy bank"})
}

func main() {
	addr := flag.String("addr", ":7443", "HTTPS address (the default listens on every network interface)")
	httpAddr := flag.String("http", ":7080", "plain HTTP address that redirects to HTTPS and offers /ca.crt (empty disables it)")
	dataPath := flag.String("data", "piggybank.json", "file where savings are stored")
	certDir := flag.String("certs", "certs", "folder for the generated local CA and server certificate")
	certFile := flag.String("cert", "", "use this TLS certificate (e.g. from mkcert) instead of generating one")
	keyFile := flag.String("key", "", "private key for -cert")
	flag.Parse()

	st, err := openStore(*dataPath)
	if err != nil {
		log.Fatalf("open data file: %v", err)
	}
	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	_, httpsPort, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatalf("invalid -addr %q: %v", *addr, err)
	}

	app := &server{store: st}
	var cert tls.Certificate
	if *certFile != "" || *keyFile != "" {
		if cert, err = tls.LoadX509KeyPair(*certFile, *keyFile); err != nil {
			log.Fatalf("load -cert/-key: %v", err)
		}
	} else {
		ca, err := loadOrCreateCA(*certDir)
		if err != nil {
			log.Fatalf("certificate authority: %v", err)
		}
		names, ips := localAddresses()
		if cert, err = ca.serverCert(*certDir, names, ips); err != nil {
			log.Fatalf("server certificate: %v", err)
		}
		app.caDER = ca.cert.Raw
	}

	// Claim the ports before announcing anything, so a busy port fails clearly.
	secureLn := listen(*addr, "-addr")
	var plainLn net.Listener
	if *httpAddr != "" {
		plainLn = listen(*httpAddr, "-http")
	}

	errc := make(chan error, 2)
	if plainLn != nil {
		plain := &http.Server{Handler: app.redirectHandler(httpsPort), ReadHeaderTimeout: 5 * time.Second}
		go func() { errc <- fmt.Errorf("http: %w", plain.Serve(plainLn)) }()
	}
	secure := &http.Server{
		Handler:           app.routes(static),
		ReadHeaderTimeout: 5 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
	go func() { errc <- fmt.Errorf("https: %w", secure.ServeTLS(secureLn, "", "")) }()

	printURLs(httpsPort, *httpAddr, app.caDER != nil, *dataPath)
	log.Fatal(<-errc)
}

func listen(addr, flagName string) net.Listener {
	ln, err := net.Listen("tcp", addr)
	if errors.Is(err, syscall.EADDRINUSE) {
		log.Fatalf("%s is already used by another program. Pick a different port, e.g.: go run . %s :<port>", addr, flagName)
	}
	if err != nil {
		log.Fatalf("listen on %s: %v", addr, err)
	}
	return ln
}

func printURLs(httpsPort, httpAddr string, haveCA bool, dataPath string) {
	url := func(host string) string { return "https://" + net.JoinHostPort(host, httpsPort) }
	names, ips := localAddresses()
	var lanIPs []string
	for _, ip := range ips {
		if !ip.IsLoopback() && ip.To4() != nil {
			lanIPs = append(lanIPs, ip.String())
		}
	}
	lan := make([]string, 0, len(lanIPs)+1)
	for _, ip := range lanIPs {
		lan = append(lan, url(ip))
	}
	if len(names) > 2 {
		lan = append(lan, url(names[2])) // hostname.local
	}

	fmt.Printf("\n🐷 Piggy Bank is running (savings in %s)\n\n", dataPath)
	fmt.Printf("   %-15s %s\n", "This computer:", url("localhost"))
	for i, u := range lan {
		label := ""
		if i == 0 {
			label = "Your network:"
		}
		fmt.Printf("   %-15s %s\n", label, u)
	}
	if haveCA && httpAddr != "" && len(lanIPs) > 0 {
		if _, httpPort, err := net.SplitHostPort(httpAddr); err == nil {
			fmt.Printf("\n   No HTTPS warning on phones: install http://%s/ca.crt once (see README).\n",
				net.JoinHostPort(lanIPs[0], httpPort))
		}
	}
	fmt.Println()
}
