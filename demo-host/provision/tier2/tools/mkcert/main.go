// Command mkcert writes a throwaway self-signed certificate and key for
// localhost to a directory: the TLS identity of the local ACME CA, which Caddy
// is told to trust as a root. Valid for a day, so no fixture can expire in
// the repository.
//
// Usage: mkcert DIRECTORY   (writes cert.pem and key.pem)
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

const validity = 24 * time.Hour

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: mkcert DIRECTORY")
	}
	if err := write(os.Args[1]); err != nil {
		log.Fatal(err)
	}
}

func write(directory string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "localhost"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := writePEM(filepath.Join(directory, "cert.pem"), "CERTIFICATE", der); err != nil {
		return err
	}
	return writePEM(filepath.Join(directory, "key.pem"), "EC PRIVATE KEY", keyDER)
}

func writePEM(path string, blockType string, der []byte) error {
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600)
}
