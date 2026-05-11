package trace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

type fixtureFile struct {
	ParseCases       []parseCase  `json:"parseCases"`
	HeaderArrayCases []headerCase `json:"headerArrayCases"`
}

type parseCase struct {
	Name        string          `json:"name"`
	RawType     string          `json:"rawType"`
	Raw         json.RawMessage `json:"raw"`
	ExpectOk    bool            `json:"expectOk"`
	ExpectIssue string          `json:"expectIssue"`
}

type headerCase struct {
	Name        string          `json:"name"`
	Raw         json.RawMessage `json:"raw"`
	ExpectOk    bool            `json:"expectOk"`
	ExpectIssue string          `json:"expectIssue"`
}

func loadFixture(t *testing.T) fixtureFile {
	t.Helper()
	// node-agent/internal/trace → 上溯 4 级到 packages/,再下到 protocol/testdata
	path := filepath.Join("..", "..", "..", "..", "protocol", "testdata", "trace-id-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	var f fixtureFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(f.ParseCases) < 10 {
		t.Fatalf("fixture parseCases shrunk unexpectedly: %d", len(f.ParseCases))
	}
	return f
}

// decodeRaw 按 fixture rawType discriminator 把 json.RawMessage 解到 Go any。
// number → float64(JSON number 默认),boolean/object/array/null/string 按 spec。
func decodeRaw(t *testing.T, rawType string, raw json.RawMessage) any {
	t.Helper()
	switch rawType {
	case "null":
		return nil
	case "string":
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("decode string: %v", err)
		}
		return s
	case "number":
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil {
			t.Fatalf("decode number: %v", err)
		}
		return n
	case "boolean":
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			t.Fatalf("decode bool: %v", err)
		}
		return b
	case "object":
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("decode object: %v", err)
		}
		return m
	case "array":
		var a []any
		if err := json.Unmarshal(raw, &a); err != nil {
			t.Fatalf("decode array: %v", err)
		}
		return a
	default:
		t.Fatalf("unknown rawType: %s", rawType)
		return nil
	}
}

func TestParseCandidate_FixtureEquivalence(t *testing.T) {
	f := loadFixture(t)
	for _, c := range f.ParseCases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			in := decodeRaw(t, c.RawType, c.Raw)
			id, issue, ok := ParseCandidate(in)
			if ok != c.ExpectOk {
				t.Fatalf("ok mismatch: got %v want %v (id=%q issue=%q)", ok, c.ExpectOk, id, issue)
			}
			if c.ExpectOk && id == "" {
				t.Errorf("expected id non-empty when ok=true")
			}
			if !c.ExpectOk && string(issue) != c.ExpectIssue {
				t.Errorf("issue mismatch: got %q want %q", issue, c.ExpectIssue)
			}
		})
	}
}

func TestParseHeader_ArrayFirstUnwrap(t *testing.T) {
	f := loadFixture(t)
	for _, c := range f.HeaderArrayCases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			// 模拟 r.Header.Values 返回:数组 → 取 [0],空数组 → present=false
			var values []any
			if err := json.Unmarshal(c.Raw, &values); err != nil {
				t.Fatalf("decode array: %v", err)
			}
			var rawValue string
			present := len(values) > 0
			if present {
				s, ok := values[0].(string)
				if !ok {
					t.Fatalf("headerArrayCases[0] should be string in fixture, got %T", values[0])
				}
				rawValue = s
			}
			id, issue, ok := ParseHeader(rawValue, present)
			if ok != c.ExpectOk {
				t.Fatalf("ok mismatch: got %v want %v (id=%q issue=%q)", ok, c.ExpectOk, id, issue)
			}
			if !c.ExpectOk && string(issue) != c.ExpectIssue {
				t.Errorf("issue mismatch: got %q want %q", issue, c.ExpectIssue)
			}
		})
	}
}

func TestNewTraceID_FormatAndRegex(t *testing.T) {
	re := regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		id := NewTraceID()
		if len(id) != 32 {
			t.Fatalf("NewTraceID length = %d, want 32", len(id))
		}
		if !re.MatchString(id) {
			t.Fatalf("NewTraceID %q does not match TRACE_ID_REGEX", id)
		}
		if seen[id] {
			// 撞 hex 16 字节生日界约 2^64,64 次基本不可能重(false positive 概率 ~1e-17)
			t.Fatalf("NewTraceID duplicate within small batch: %q (entropy bug?)", id)
		}
		seen[id] = true
	}
}
