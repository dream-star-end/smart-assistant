package containers

import (
	"bytes"
	"encoding/json"
	"regexp"
)

type RuntimeInspection struct {
	Version        int                      `json:"version"`
	Id             string                   `json:"id"`
	ImageId        string                   `json:"imageId"`
	ConfiguredUser string                   `json:"configuredUser"`
	IdentityLabels map[string]string        `json:"identityLabels"`
	Mounts         []RuntimeMountInspection `json:"mounts"`
	Tmpfs          map[string]string        `json:"tmpfs"`
}
type RuntimeMountInspection struct {
	Type        string  `json:"type"`
	Source      string  `json:"source"`
	Destination string  `json:"destination"`
	RW          bool    `json:"rw"`
	Propagation string  `json:"propagation"`
	Mode        *string `json:"mode,omitempty"`
	Name        *string `json:"name,omitempty"`
	Driver      *string `json:"driver,omitempty"`
}

var inspectionCID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var inspectionImage = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var inspectionLabelKeys = map[string]bool{
	"com.openclaude.v3.managed": true, "com.openclaude.v3.uid": true, "com.openclaude.v3.containerDbId": true,
	"com.openclaude.runtime_channel": true, "com.openclaude.runtime.image_id": true,
	"com.openclaude.runtime.release": true, "com.openclaude.runtime.bundle_rev": true, "com.openclaude.runtime.boot_hash": true,
}

func inspectionObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var value map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, false
	}
	return value, true
}
func inspectionString(raw json.RawMessage) *string {
	var value *string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}
func inspectionStrings(raw json.RawMessage) (map[string]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return map[string]string{}, true
	}
	values, ok := inspectionObject(raw)
	if !ok {
		return nil, false
	}
	result := map[string]string{}
	for key, item := range values {
		value := inspectionString(item)
		if value == nil {
			return nil, false
		}
		result[key] = *value
	}
	return result, true
}

// Parse the same response already used for state; no second Docker request or expected spec.
// A missing field is unknown. Docker's omitted empty Tmpfs is intentionally conservative.
func runtimeInspectionFromInspect(raw []byte, expectedID string) *RuntimeInspection {
	if !inspectionCID.MatchString(expectedID) {
		return nil
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || len(entries) != 1 {
		return nil
	}
	obj, ok := inspectionObject(entries[0])
	if !ok {
		return nil
	}
	id := inspectionString(obj["Id"])
	image := inspectionString(obj["Image"])
	if id == nil || *id != expectedID || image == nil || !inspectionImage.MatchString(*image) {
		return nil
	}
	cfg, ok := inspectionObject(obj["Config"])
	if !ok {
		return nil
	}
	host, ok := inspectionObject(obj["HostConfig"])
	if !ok {
		return nil
	}
	user := inspectionString(cfg["User"])
	if user == nil {
		return nil
	}
	labels, ok := inspectionStrings(cfg["Labels"])
	if !ok {
		return nil
	}
	tmpfs, ok := inspectionStrings(host["Tmpfs"])
	if !ok {
		return nil
	}
	rawMounts, exists := obj["Mounts"]
	if !exists || bytes.Equal(bytes.TrimSpace(rawMounts), []byte("null")) {
		return nil
	}
	var mounts []json.RawMessage
	if json.Unmarshal(rawMounts, &mounts) != nil {
		return nil
	}
	result := &RuntimeInspection{Version: 1, Id: *id, ImageId: *image, ConfiguredUser: *user,
		IdentityLabels: map[string]string{}, Mounts: make([]RuntimeMountInspection, 0, len(mounts)), Tmpfs: tmpfs}
	for key, value := range labels {
		if inspectionLabelKeys[key] {
			result.IdentityLabels[key] = value
		}
	}
	for _, rawMount := range mounts {
		item, ok := inspectionObject(rawMount)
		if !ok {
			return nil
		}
		typ := inspectionString(item["Type"])
		source := inspectionString(item["Source"])
		dest := inspectionString(item["Destination"])
		prop := inspectionString(item["Propagation"])
		var rw *bool
		if typ == nil || *typ == "" || source == nil || dest == nil || prop == nil || len(item["RW"]) == 0 || json.Unmarshal(item["RW"], &rw) != nil || rw == nil {
			return nil
		}
		mount := RuntimeMountInspection{Type: *typ, Source: *source, Destination: *dest, RW: *rw, Propagation: *prop}
		for key, target := range map[string]**string{"Mode": &mount.Mode, "Name": &mount.Name, "Driver": &mount.Driver} {
			if rawValue, exists := item[key]; exists {
				value := inspectionString(rawValue)
				if value == nil {
					return nil
				}
				*target = value
			}
		}
		result.Mounts = append(result.Mounts, mount)
	}
	return result
}
