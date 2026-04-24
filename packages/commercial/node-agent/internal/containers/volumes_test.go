package containers

import "testing"

func TestValidateVolumeName(t *testing.T) {
	// 必须跟 master TS 侧 v3VolumeNameFor / v3ProjectsVolumeNameFor 对齐:
	// `oc-v3-data-u<uid>` / `oc-v3-proj-u<uid>`,uid 正整数无前导 0。
	ok := []string{
		"oc-v3-data-u1",
		"oc-v3-data-u22",
		"oc-v3-proj-u22",
		"oc-v3-data-u9999999999999999",
	}
	for _, name := range ok {
		if err := ValidateVolumeName(name); err != nil {
			t.Errorf("ValidateVolumeName(%q) should pass, got: %v", name, err)
		}
	}

	bad := []string{
		"",
		"oc-v3-vol-u1",                  // legacy never-used prefix
		"oc-v3-data-u0",                 // leading zero / zero uid
		"oc-v3-data-u01",                // leading zero
		"oc-v3-data-",                   // no uid
		"oc-v3-data-uabc",               // non-digit
		"oc-v3-cache-u1",                // unknown category
		"oc-v3-data-u1 ; rm -rf /",      // shell injection attempt
		"oc-v3-data-u12345678901234567", // >16 digits
		"OC-V3-DATA-U1",                 // uppercase
	}
	for _, name := range bad {
		if err := ValidateVolumeName(name); err == nil {
			t.Errorf("ValidateVolumeName(%q) should fail but passed", name)
		}
	}
}

func TestValidateCid(t *testing.T) {
	ok := []string{
		"oc-v3-u22",
		"oc-v3-user-session-name",
		"abcdef012345",                                                     // 12-hex short docker id
		"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", // 64-hex full id
	}
	for _, s := range ok {
		if err := ValidateCid(s); err != nil {
			t.Errorf("ValidateCid(%q) should pass, got: %v", s, err)
		}
	}
	bad := []string{
		"",
		"not-oc-prefix",
		"ABCDEF012345",     // uppercase hex — reject
		"abcdef01",         // too short hex (< 12)
		"oc-v3-u22 ; rm",   // injection
		"/tmp/foo",
	}
	for _, s := range bad {
		if err := ValidateCid(s); err == nil {
			t.Errorf("ValidateCid(%q) should fail but passed", s)
		}
	}
}

func TestValidateContainerName(t *testing.T) {
	if err := ValidateContainerName("oc-v3-u22"); err != nil {
		t.Errorf("oc-v3-u22 should pass, got: %v", err)
	}
	// docker hex id should NOT pass as a container name (Run requires oc-v3-* name)
	if err := ValidateContainerName("abcdef012345"); err == nil {
		t.Errorf("hex id should not be accepted as container name")
	}
}

func TestIsNamedVolumeSource(t *testing.T) {
	yes := []string{"oc-v3-data-u22", "oc-v3-proj-u1"}
	no := []string{
		"/var/lib/openclaude/baseline/skills", // abs path
		"oc-v3-data-u0",                       // regex rejects zero uid
		"",
		"../foo",        // relative
		"foo-v3-data-u1",// wrong prefix
	}
	for _, s := range yes {
		if !isNamedVolumeSource(s) {
			t.Errorf("%q should be detected as named volume", s)
		}
	}
	for _, s := range no {
		if isNamedVolumeSource(s) {
			t.Errorf("%q should NOT be detected as named volume", s)
		}
	}
}
