package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestGracefulShutdownFinishesAnAcceptedRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- serve(ctx, listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; w.Write([]byte("completed")) }))
	}()
	result := make(chan string, 1)
	go func() {
		r, err := http.Get("http://" + listener.Addr().String())
		if err != nil {
			result <- "error"
			return
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		result <- string(body)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("request did not enter")
	}
	cancel()
	select {
	case err := <-finished:
		t.Fatalf("shutdown returned before accepted work completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case body := <-result:
		if body != "completed" {
			t.Fatalf("response=%q", body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("accepted response did not complete")
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not stop")
	}
}
func TestGracefulShutdownStopsIdleListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := serve(ctx, listener, http.NewServeMux()); err != nil {
		t.Fatal(err)
	}
	if conn, err := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond); err == nil {
		conn.Close()
		t.Fatal("listener still accepts connections")
	}
}
