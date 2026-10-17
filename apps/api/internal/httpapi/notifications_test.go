package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNotificationStrictInputs(t *testing.T) {
	for _, body := range []string{
		`{"id":"a","id":"b","expectedSourceRevision":"1"}`,
		`{"id":"a","\u0069d":"b","expectedSourceRevision":"1"}`,
		`{"id":"a","ID":"b","expectedSourceRevision":"1"}`,
		`{"id":"a","expectedSourceRevision":"1","wallet":"other"}`,
		`{"id":"a","expectedSourceRevision":"1"} {}`,
		`{"id":[],"expectedSourceRevision":"1"}`,
		`{"id":"a","expectedSourceRevision":1}`,
		`[]`, `null`, `{"id":"a"`,
		strings.Repeat(" ",4097),
	} {
		t.Run(body[:min(len(body),70)],func(t *testing.T) {
			var input notificationReadInput
			if err := notificationReadJSON(httptest.NewRequest("POST","/",strings.NewReader(body)),&input); err==nil {
				t.Fatal("ambiguous or unsupported input accepted")
			}
		})
	}
	var input notificationReadInput
	if err := notificationReadJSON(httptest.NewRequest("POST","/",strings.NewReader(`{"id":"a","expectedSourceRevision":"1"}`)),&input); err!=nil || input.ID!="a" {
		t.Fatal("exact typed input refused",err)
	}
	for _, value := range []string{"","00","01","-1","1.0","1e1","18446744073709551616"} {
		if _,ok := notificationRevision(value,true);ok {
			t.Fatalf("invalid revision accepted: %q",value)
		}
	}
	if n,ok := notificationRevision("18446744073709551615",false);!ok || n!=^uint64(0) {
		t.Fatal("full unsigned revision rejected")
	}
	if _,ok := notificationRevision("0",false);ok {
		t.Fatal("zero source revision accepted")
	}
	if _,ok := notificationRevision("0",true);!ok {
		t.Fatal("initial preference revision rejected")
	}
}

func TestNotificationUnauthenticatedNoStore(t *testing.T) {
	mux := http.NewServeMux()
	registerNotifications(mux,&userAuthService{})
	for _, route := range []struct{method,path string}{
		{"GET","/v1/user/notifications"},{"POST","/v1/user/notifications/read"},
		{"GET","/v1/user/notification-preferences"},{"PUT","/v1/user/notification-preferences"},
	} {
		out := httptest.NewRecorder()
		mux.ServeHTTP(out,httptest.NewRequest(route.method,route.path,nil))
		if out.Code!=401 || out.Header().Get("Cache-Control")!="no-store" {
			t.Fatalf("private refusal %s %d %v",route.path,out.Code,out.Header())
		}
	}
}

func TestNotificationPageDoesNotSerializeInternalInventory(t *testing.T) {
	b,err := json.Marshal(notificationPage{allNotifications:[]inboxNotification{{ID:"private-hidden"}}})
	if err!=nil || strings.Contains(string(b),"private-hidden") || strings.Contains(string(b),"allNotifications") {
		t.Fatal("internal unfiltered inventory serialized",err)
	}
}
