// Package stubdns is a test-only Caddy DNS provider that publishes ACME
// DNS-01 TXT records to a pebble-challtestsrv management API.
//
// It stands in for the Hetzner provider in the demo edge's Tier 2 proof. Its
// Caddyfile grammar and its Provision call copy the Hetzner module's, so
// `dns challtestsrv {file./abs/path}` reaches it exactly as the production
// directive reaches the Hetzner module. The one argument is the management
// API's base URL instead of an API token.
package stubdns

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/libdns/libdns"
)

const requestTimeout = 10 * time.Second

// Provider publishes and clears TXT records through challtestsrv.
type Provider struct {
	// ManagementURL is the challtestsrv management API base URL.
	ManagementURL string `json:"management_url,omitempty"`
}

func init() { caddy.RegisterModule(new(Provider)) }

// CaddyModule returns the Caddy module information.
func (*Provider) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "dns.providers.challtestsrv",
		New: func() caddy.Module { return new(Provider) },
	}
}

// Provision resolves placeholders the way the Hetzner module does.
func (provider *Provider) Provision(_ caddy.Context) error {
	provider.ManagementURL = caddy.NewReplacer().ReplaceAll(provider.ManagementURL, "")
	return nil
}

// UnmarshalCaddyfile accepts `challtestsrv <management_url>`.
func (provider *Provider) UnmarshalCaddyfile(dispenser *caddyfile.Dispenser) error {
	for dispenser.Next() {
		if !dispenser.NextArg() {
			return dispenser.ArgErr()
		}
		provider.ManagementURL = dispenser.Val()
		if dispenser.NextArg() {
			return dispenser.ArgErr()
		}
	}
	return nil
}

// AppendRecords sets each record's value on its fully qualified name.
func (provider *Provider) AppendRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	for _, record := range records {
		rr := record.RR()
		body := map[string]string{"host": fullyQualified(rr.Name, zone), "value": rr.Data}
		if err := provider.post(ctx, "/set-txt", body); err != nil {
			return nil, err
		}
	}
	return records, nil
}

// DeleteRecords clears each record's name.
func (provider *Provider) DeleteRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	for _, record := range records {
		body := map[string]string{"host": fullyQualified(record.RR().Name, zone)}
		if err := provider.post(ctx, "/clear-txt", body); err != nil {
			return nil, err
		}
	}
	return records, nil
}

func fullyQualified(name string, zone string) string {
	return strings.TrimSuffix(libdns.AbsoluteName(name, zone), ".") + "."
}

func (provider *Provider) post(ctx context.Context, path string, body map[string]string) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(provider.ManagementURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("challtestsrv %s: %w", path, err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("challtestsrv %s: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("challtestsrv %s: %s", path, response.Status)
	}
	return nil
}

var (
	_ caddyfile.Unmarshaler = (*Provider)(nil)
	_ caddy.Provisioner     = (*Provider)(nil)
	_ libdns.RecordAppender = (*Provider)(nil)
	_ libdns.RecordDeleter  = (*Provider)(nil)
)
