// Command tier2caddy is Caddy with the standard modules and the stub DNS
// provider, the same program xcaddy would generate for this plugin. It is a
// committed module so that go.sum pins every dependency by hash.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "example.test/stubdns"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}
