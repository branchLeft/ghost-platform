// Command soashim is a DNS front for pebble-challtestsrv. certmagic finds the
// zone of a challenge name by SOA lookups, which challtestsrv does not answer
// (it replies NOTIMP), so soashim answers the SOA of one zone itself and
// forwards every other query upstream, TXT lookups included. It logs one line
// per query so a run shows which names Caddy asked about.
//
// Usage: soashim LISTEN_ADDRESS ZONE UPSTREAM_ADDRESS
package main

import (
	"log"
	"os"
	"strings"

	"github.com/miekg/dns"
)

const recordTTLSeconds = 60

func main() {
	if len(os.Args) != 4 {
		log.Fatal("usage: soashim LISTEN_ADDRESS ZONE UPSTREAM_ADDRESS")
	}
	listen, zone, upstream := os.Args[1], dns.Fqdn(os.Args[2]), os.Args[3]
	handler := dns.HandlerFunc(func(writer dns.ResponseWriter, request *dns.Msg) {
		answer(writer, request, zone, upstream)
	})
	for _, network := range []string{"udp", "tcp"} {
		server := &dns.Server{Addr: listen, Net: network, Handler: handler}
		go func() { log.Fatal(server.ListenAndServe()) }()
	}
	select {}
}

func answer(writer dns.ResponseWriter, request *dns.Msg, zone string, upstream string) {
	question := request.Question[0]
	log.Printf("query %s type=%s", question.Name, dns.TypeToString[question.Qtype])
	if question.Qtype != dns.TypeSOA {
		forward(writer, request, upstream)
		return
	}
	reply := new(dns.Msg)
	reply.SetReply(request)
	reply.Authoritative = true
	if strings.EqualFold(question.Name, zone) {
		reply.Answer = append(reply.Answer, zoneStartOfAuthority(zone))
	}
	if err := writer.WriteMsg(reply); err != nil {
		log.Printf("write reply: %v", err)
	}
}

func zoneStartOfAuthority(zone string) *dns.SOA {
	return &dns.SOA{
		Hdr:     dns.RR_Header{Name: zone, Rrtype: dns.TypeSOA, Class: dns.ClassINET, Ttl: recordTTLSeconds},
		Ns:      "ns." + zone,
		Mbox:    "hostmaster." + zone,
		Serial:  1,
		Refresh: recordTTLSeconds,
		Retry:   recordTTLSeconds,
		Expire:  recordTTLSeconds,
		Minttl:  recordTTLSeconds,
	}
}

func forward(writer dns.ResponseWriter, request *dns.Msg, upstream string) {
	reply, _, err := new(dns.Client).Exchange(request, upstream)
	if err != nil {
		log.Printf("forward to %s: %v", upstream, err)
		reply = new(dns.Msg)
		reply.SetRcode(request, dns.RcodeServerFailure)
	}
	if err := writer.WriteMsg(reply); err != nil {
		log.Printf("write reply: %v", err)
	}
}
