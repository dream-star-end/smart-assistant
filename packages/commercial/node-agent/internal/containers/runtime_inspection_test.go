package containers

import (
	"context"
	"encoding/json"
	"github.com/openclaude/node-agent/internal/config"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func inspectionFixture() map[string]any {
	return map[string]any{"Id": strings.Repeat("a", 64), "Image": "sha256:" + strings.Repeat("b", 64),
		"State": map[string]any{"Status": "running"}, "Config": map[string]any{"User": "1000:1000", "Labels": map[string]any{"com.openclaude.v3.uid": "765", "not-identity": "fixture-private"}},
		"HostConfig": map[string]any{"Tmpfs": map[string]any{"/run/oc/claude-config": "rw,noexec"}},
		"Mounts": []any{map[string]any{"Type": "volume", "Name": "oc-v5-data-u765", "Driver": "local", "Source": "/fixture/data", "Destination": "/home/agent/.openclaude", "RW": true, "Mode": "rw", "Propagation": ""},
			map[string]any{"Type": "bind", "Source": "/fixture/state", "Destination": "/run/oc/system-state", "RW": false, "Mode": "ro", "Propagation": "rprivate"}}}
}
func inspectionBytes(value map[string]any) []byte { raw, _ := json.Marshal([]any{value}); return raw }
func TestRuntimeInspectionComplete(t *testing.T) {
	value := inspectionFixture()
	got := runtimeInspectionFromInspect(inspectionBytes(value), strings.Repeat("a", 64))
	if got == nil || got.Version != 1 || len(got.Mounts) != 2 || !got.Mounts[0].RW || got.Mounts[1].RW || got.Mounts[0].Name == nil || *got.Mounts[0].Name != "oc-v5-data-u765" {
		t.Fatalf("complete snapshot missing")
	}
	encoded, _ := json.Marshal(got)
	if strings.Contains(string(encoded), "fixture-private") {
		t.Fatal("non-identity label leaked")
	}
}
func TestRuntimeInspectionUnknown(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"missing mounts": func(v map[string]any) { delete(v, "Mounts") }, "null mounts": func(v map[string]any) { v["Mounts"] = nil },
		"missing tmpfs":  func(v map[string]any) { v["HostConfig"] = map[string]any{} },
		"missing user":   func(v map[string]any) { delete(v["Config"].(map[string]any), "User") },
		"missing labels": func(v map[string]any) { delete(v["Config"].(map[string]any), "Labels") },
		"null map value": func(v map[string]any) { v["HostConfig"] = map[string]any{"Tmpfs": map[string]any{"/run/a": nil}} },
		"wrong id":       func(v map[string]any) { v["Id"] = strings.Repeat("c", 64) },
		"bad image":      func(v map[string]any) { v["Image"] = "mutable:tag" },
		"missing rw":     func(v map[string]any) { delete(v["Mounts"].([]any)[0].(map[string]any), "RW") },
		"null rw":        func(v map[string]any) { v["Mounts"].([]any)[0].(map[string]any)["RW"] = nil },
		"string rw":      func(v map[string]any) { v["Mounts"].([]any)[0].(map[string]any)["RW"] = "false" },
		"bad optional":   func(v map[string]any) { v["Mounts"].([]any)[1].(map[string]any)["Name"] = nil },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			value := inspectionFixture()
			mutate(value)
			if runtimeInspectionFromInspect(inspectionBytes(value), strings.Repeat("a", 64)) != nil {
				t.Fatal("invalid metadata became known")
			}
		})
	}
}
func TestRuntimeInspectionExplicitEmpty(t *testing.T) {
	value := inspectionFixture()
	value["Config"] = map[string]any{"User": "", "Labels": nil}
	value["HostConfig"] = map[string]any{"Tmpfs": nil}
	value["Mounts"] = []any{}
	got := runtimeInspectionFromInspect(inspectionBytes(value), strings.Repeat("a", 64))
	if got == nil || len(got.Mounts) != 0 || len(got.Tmpfs) != 0 || got.ConfiguredUser != "" {
		t.Fatal("explicit empty lost")
	}
}
func TestRunnerInspectIncludesSameActualSnapshot(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "docker")
	fixture := filepath.Join(dir, "inspect.json")
	script := "#!/bin/sh\nif [ \"$1\" = ps ]; then echo " + strings.Repeat("a", 64) + "; exit 0; fi\nif [ \"$1\" = inspect ] && [ \"$2\" = -f ]; then echo 1; exit 0; fi\ncat \"$(dirname \"$0\")/inspect.json\"\n"
	if err := os.WriteFile(stub, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture, inspectionBytes(inspectionFixture()), 0600); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(&config.Config{DockerBin: stub})
	got, err := runner.Inspect(context.Background(), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if got.RuntimeInspection == nil || got.State != "running" || got.Id != got.RuntimeInspection.Id {
		t.Fatal("actual runner dropped inspection evidence")
	}
	listed, err := runner.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].RuntimeInspection != nil {
		t.Fatal("list polling must retain its prior payload")
	}
	if err := os.WriteFile(fixture, []byte(`[{"Id":"`+strings.Repeat("a", 64)+`","State":{"Status":"running"}}]`), 0600); err != nil {
		t.Fatal(err)
	}
	old, err := runner.Inspect(context.Background(), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if old.RuntimeInspection != nil || old.State != "running" {
		t.Fatal("old inspect is not compatible unknown")
	}
}
