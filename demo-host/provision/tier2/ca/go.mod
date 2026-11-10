module example.test/tier2ca

go 1.25.0

tool (
	github.com/letsencrypt/pebble/v2/cmd/pebble
	github.com/letsencrypt/pebble/v2/cmd/pebble-challtestsrv
)

require (
	github.com/go-jose/go-jose/v4 v4.1.4 // indirect
	github.com/letsencrypt/challtestsrv v1.4.2 // indirect
	github.com/letsencrypt/pebble/v2 v2.10.1 // indirect
	github.com/miekg/dns v1.1.62 // indirect
	golang.org/x/mod v0.24.0 // indirect
	golang.org/x/net v0.40.0 // indirect
	golang.org/x/sync v0.14.0 // indirect
	golang.org/x/sys v0.33.0 // indirect
	golang.org/x/tools v0.33.0 // indirect
)
