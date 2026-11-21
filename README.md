# 🐷 Piggy Bank

A tiny savings game. Drag euro coins and notes into the piggy bank and watch it
fill up with gold towards your monthly goal (1.000 € by default, changeable in
⚙️ Settings). Works on phones, tablets and desktops.

It's a single Go program with no dependencies; the web page is built into it.

## Run

```bash
go run .
```

or build it once and run the binary:

```bash
go build && ./piggybank
```

On start it prints the addresses to open, for example:

```
   This computer:  https://localhost:8443
   Your network:   https://192.168.188.61:8443
                   https://betula-papyrifera.local:8443
```

Open the "Your network" address on any phone or tablet in the same Wi-Fi.
`http://…:8080` also works; it redirects to HTTPS.

Your savings are stored in `piggybank.json` next to where you start it.

### Options

| Flag     | Default          | What it does                                                    |
|----------|------------------|-----------------------------------------------------------------|
| `-addr`  | `:8443`          | HTTPS address (all network interfaces)                          |
| `-http`  | `:8080`          | HTTP address that redirects to HTTPS (`-http ""` turns it off)  |
| `-data`  | `piggybank.json` | where savings are stored                                        |
| `-certs` | `certs`          | where the generated certificates are kept                       |
| `-cert`, `-key` | –         | use your own certificate instead (e.g. from `mkcert`)          |

## HTTPS on your phone

On first start the app creates its own little certificate authority in
`certs/` and uses it to sign a certificate for this computer's name and network
addresses. If the computer's IP changes, the certificate is renewed
automatically on the next start.

Browsers don't know this certificate authority yet, so the first visit shows a
warning. You can tap through it ("Advanced → Proceed"), or trust it once so the
warning goes away for good:

**iPhone / iPad**

1. In Safari open `http://<computer-ip>:8080/ca.crt` and allow the download.
2. Settings → General → VPN & Device Management → *Piggy Bank Local CA* → Install.
3. Settings → General → About → Certificate Trust Settings → turn on *Piggy Bank Local CA*.

**Android**

1. Open `http://<computer-ip>:8080/ca.crt` to download it.
2. Settings → Security → More security settings → Encryption & credentials →
   Install a certificate → CA certificate → pick `piggybank-ca.crt`.
   (The exact menu names differ a little between phone makers.)

**This computer:** import `certs/ca.pem` into your browser or system trust store,
or skip the warning once.

Keep the `certs/` folder private: it contains the CA's private key.
Deleting it creates a fresh CA on the next start (phones then need to trust the new one).

## Firewall

If phones can't connect, allow the ports, e.g. with ufw:

```bash
sudo ufw allow 8443/tcp
sudo ufw allow 8080/tcp
```
