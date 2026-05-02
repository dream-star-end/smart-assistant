// files_test.go — 覆盖 v1.0.72 新加的 owner_uid/owner_gid 解析 + chown 行为。
//
// 不测原有 PUT/DELETE/STAT 主流程(那部分已在生产稳定多版本)。仅锁定:
//   - parseOwner 严格策略(缺一 / 负数 / overflow / 非数字 → error)
//   - handlePut 在带 owner 参数时调 osChown(用 var 替换 mock)
//   - chown 失败 → 500 CHOWN_FAIL + tmp 清理
//   - 不带 owner 参数 → 不调 chown(向后兼容,老 master 不受影响)
package files

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOwner(t *testing.T) {
	cases := []struct {
		name      string
		uidRaw    string
		gidRaw    string
		wantHas   bool
		wantUID   int
		wantGID   int
		wantErr   bool
		errSubstr string
	}{
		{name: "both empty → no owner", wantHas: false},
		{name: "valid uid+gid", uidRaw: "1000", gidRaw: "1000", wantHas: true, wantUID: 1000, wantGID: 1000},
		{name: "uid only → 400", uidRaw: "1000", wantErr: true, errSubstr: "both"},
		{name: "gid only → 400", gidRaw: "1000", wantErr: true, errSubstr: "both"},
		{name: "negative uid → 400", uidRaw: "-1", gidRaw: "0", wantErr: true, errSubstr: "non-negative"},
		{name: "negative gid → 400", uidRaw: "0", gidRaw: "-5", wantErr: true, errSubstr: "non-negative"},
		{name: "non-numeric uid → 400", uidRaw: "abc", gidRaw: "0", wantErr: true, errSubstr: "invalid"},
		{name: "non-numeric gid → 400", uidRaw: "0", gidRaw: "x", wantErr: true, errSubstr: "invalid"},
		{name: "overflow uid → 400", uidRaw: "999999999999", gidRaw: "0", wantErr: true, errSubstr: "invalid"},
		{name: "zero uid+gid (root) OK", uidRaw: "0", gidRaw: "0", wantHas: true, wantUID: 0, wantGID: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uid, gid, has, err := parseOwner(tc.uidRaw, tc.gidRaw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if tc.errSubstr != "" && !strings.Contains(err.Error(), tc.errSubstr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.errSubstr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if has != tc.wantHas {
				t.Fatalf("hasOwner: want %v got %v", tc.wantHas, has)
			}
			if has {
				if uid != tc.wantUID || gid != tc.wantGID {
					t.Fatalf("uid/gid: want %d/%d got %d/%d", tc.wantUID, tc.wantGID, uid, gid)
				}
			}
		})
	}
}

// withTempAllowedRoot 临时把 dir 加入 AllowedRoots,return cleanup。
// 不并发安全,t.Parallel 不可与该 helper 共用。
func withTempAllowedRoot(t *testing.T, dir string) func() {
	t.Helper()
	orig := AllowedRoots
	AllowedRoots = append(append([]string{}, orig...), dir)
	return func() { AllowedRoots = orig }
}

func TestHandlePut_OwnerChown_Success(t *testing.T) {
	// 测试 mock:override osChown 记录调用参数。返回 nil(成功)。
	// 真实 chown 在非 root 跑测试时会 EPERM,所以必须 mock。
	var gotPath string
	var gotUID, gotGID int
	var chownCalled bool
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		chownCalled = true
		gotPath = name
		gotUID = uid
		gotGID = gid
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "auth.json")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0400")
	q.Set("owner_uid", "1000")
	q.Set("owner_gid", "1001")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("payload")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !chownCalled {
		t.Fatalf("osChown not called")
	}
	// chown 在 chmod 前调用,作用对象是 tmp(p+".tmp");rename 后才是 p
	if gotPath != target+".tmp" {
		t.Fatalf("chown path: want %q got %q", target+".tmp", gotPath)
	}
	if gotUID != 1000 || gotGID != 1001 {
		t.Fatalf("chown uid/gid: want 1000/1001 got %d/%d", gotUID, gotGID)
	}

	// 文件已 rename 到 target
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read final: %v", err)
	}
	if string(body) != "payload" {
		t.Fatalf("body: want %q got %q", "payload", string(body))
	}
	// tmp 已清理(rename 走的是 atomic move,tmp 不存在)
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp should be gone, stat err=%v", err)
	}
}

func TestHandlePut_NoOwner_SkipsChown(t *testing.T) {
	// 老 master 不发 owner 参数 — 必须不调 chown(向后兼容)
	var chownCalled bool
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		chownCalled = true
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "data.bin")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0644")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("x")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: want 204 got %d body=%q", rec.Code, rec.Body.String())
	}
	if chownCalled {
		t.Fatalf("osChown should not be called when owner not specified")
	}
}

func TestHandlePut_ChownFails_500AndTmpCleaned(t *testing.T) {
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		return os.ErrPermission
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "fail.json")
	q := url.Values{}
	q.Set("path", target)
	q.Set("mode", "0400")
	q.Set("owner_uid", "1000")
	q.Set("owner_gid", "1000")

	req := httptest.NewRequest(http.MethodPut, "/files?"+q.Encode(), bytes.NewReader([]byte("x")))
	rec := httptest.NewRecorder()
	(&Handler{}).handlePut(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500 got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "CHOWN_FAIL") {
		t.Fatalf("body should contain CHOWN_FAIL, got %q", rec.Body.String())
	}
	// tmp 已清理
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp should be cleaned, stat err=%v", err)
	}
	// 最终文件不应该存在(chown 失败 → 不 rename)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("final file should not exist, stat err=%v", err)
	}
}

func TestHandlePut_BadOwner_400(t *testing.T) {
	osChownOrig := osChown
	osChown = func(name string, uid, gid int) error {
		t.Fatalf("osChown must not be called when owner is invalid")
		return nil
	}
	defer func() { osChown = osChownOrig }()

	tmpDir := t.TempDir()
	cleanup := withTempAllowedRoot(t, tmpDir)
	defer cleanup()

	target := filepath.Join(tmpDir, "bad.json")

	cases := []struct {
		name string
		q    url.Values
	}{
		{"uid only", url.Values{"path": []string{target}, "owner_uid": []string{"1000"}}},
		{"gid only", url.Values{"path": []string{target}, "owner_gid": []string{"1000"}}},
		{"negative uid", url.Values{"path": []string{target}, "owner_uid": []string{"-1"}, "owner_gid": []string{"0"}}},
		{"non-numeric", url.Values{"path": []string{target}, "owner_uid": []string{"foo"}, "owner_gid": []string{"0"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/files?"+tc.q.Encode(), bytes.NewReader([]byte("x")))
			rec := httptest.NewRecorder()
			(&Handler{}).handlePut(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: want 400 got %d body=%q", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "BAD_OWNER") {
				t.Fatalf("body should contain BAD_OWNER, got %q", rec.Body.String())
			}
		})
	}
}
