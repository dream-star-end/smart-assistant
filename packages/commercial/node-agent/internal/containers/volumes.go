// volumes.go — 受控的 docker volume CLI 封装。
//
// 严格约束(跟 containers.go 对齐):
//   - 所有参数通过 exec.Command(docker, args...),绝无 shell 拼接
//   - 创建带 label openclaude.v3=1;删除前必须 assertOwnedVolume 校验归属
//   - 名字 regex 白名单(仅允许 oc-v3-(data|proj)-u<uid>,与 master
//     v3VolumeNameFor/v3ProjectsVolumeNameFor 严格对齐)
//   - per-volume-name 互斥 + 全局并发(复用 globalSem)

package containers

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// reVolumeName 必须和 master TS 侧 v3VolumeNameFor / v3ProjectsVolumeNameFor
// 保持一致(packages/commercial/src/agent-sandbox/v3supervisor.ts)。
// uid 在 TS 侧是正整数,不会有前导 0,这里也收紧到 [1-9][0-9]{0,15}。
var reVolumeName = regexp.MustCompile(`^oc-v3-(data|proj)-u[1-9][0-9]{0,15}$`)

// per-volume 互斥(防止同名 create/rm 竞争)
var perVolumeMu sync.Map

func volLock(name string) *sync.Mutex {
	m, _ := perVolumeMu.LoadOrStore(name, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// ValidateVolumeName 仅允许 oc-v3-(data|proj)-u<uid> 命名,与 master 严格对齐。
func ValidateVolumeName(name string) error {
	if !reVolumeName.MatchString(name) {
		return fmt.Errorf("invalid volume name: %q", name)
	}
	return nil
}

// VolumeInspectResponse 返给 HTTP handler 的查询结果。
type VolumeInspectResponse struct {
	Exists     bool   `json:"exists"`
	Mountpoint string `json:"mountpoint,omitempty"`
}

// CreateVolume 幂等:已存在且是 openclaude.v3 归属 → 视作成功;
// 已存在但无 label(人工创建的同名 volume) → 返错,避免误当作己方资源。
func (r *Runner) CreateVolume(ctx context.Context, name string) error {
	if err := ValidateVolumeName(name); err != nil {
		return err
	}
	l := volLock(name)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()

	// 先查是否已存在
	if ii, err := r.inspectVolumeNoLock(ctx, name); err == nil && ii.Exists {
		// 已存在 → 必须是我们的(inspectVolumeNoLock 会 filter label)
		return nil
	} else if err != nil {
		// 已存在但 label 不对 / inspect 错
		// 区分"不存在"(docker volume inspect 失败 = 不存在) vs "存在但 label 不对"
		// inspectVolumeNoLock 对"存在无 label"显式返错;对"不存在"返 {Exists:false,nil}
		return err
	}

	args := []string{
		"volume", "create",
		"--label", fmt.Sprintf("%s=%s", LabelKey, LabelValue),
		name,
	}
	_, err := r.exec(ctx, args...)
	return err
}

// RemoveVolume 严格要求 label 归属;in-use 时 docker 会返错,本函数不强删(force 不暴露)。
func (r *Runner) RemoveVolume(ctx context.Context, name string) error {
	if err := ValidateVolumeName(name); err != nil {
		return err
	}
	l := volLock(name)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()

	ii, err := r.inspectVolumeNoLock(ctx, name)
	if err != nil {
		return err
	}
	if !ii.Exists {
		// 不存在视作成功(幂等 delete)
		return nil
	}
	_, err = r.exec(ctx, "volume", "rm", name)
	return err
}

// InspectVolume 外部 HTTP 入口调用,内置锁。
func (r *Runner) InspectVolume(ctx context.Context, name string) (*VolumeInspectResponse, error) {
	if err := ValidateVolumeName(name); err != nil {
		return nil, err
	}
	l := volLock(name)
	l.Lock()
	defer l.Unlock()
	release := acquire()
	defer release()
	return r.inspectVolumeNoLock(ctx, name)
}

// inspectVolumeNoLock 内部共用:查 docker volume inspect。
// 语义:
//   - volume 存在且 label=openclaude.v3=1 → {Exists:true, Mountpoint:...}
//   - volume 不存在(docker inspect 退出非 0,stderr 含 "No such volume") → {Exists:false}, nil
//   - volume 存在但 label 不对 → 返错
//   - 其它 docker 调用失败 → 返错
func (r *Runner) inspectVolumeNoLock(ctx context.Context, name string) (*VolumeInspectResponse, error) {
	out, err := r.exec(ctx, "volume", "inspect", name)
	if err != nil {
		// docker volume inspect 对不存在的 volume 返 non-zero + stderr 含 "No such volume"
		if strings.Contains(err.Error(), "No such volume") || strings.Contains(err.Error(), "no such volume") {
			return &VolumeInspectResponse{Exists: false}, nil
		}
		return nil, err
	}
	var arr []struct {
		Name       string            `json:"Name"`
		Mountpoint string            `json:"Mountpoint"`
		Labels     map[string]string `json:"Labels"`
	}
	if err := json.Unmarshal([]byte(out), &arr); err != nil {
		return nil, fmt.Errorf("parse volume inspect: %w", err)
	}
	if len(arr) == 0 {
		return &VolumeInspectResponse{Exists: false}, nil
	}
	v := arr[0]
	if v.Labels[LabelKey] != LabelValue {
		return nil, fmt.Errorf("volume %s exists but not owned by openclaude.v3", name)
	}
	return &VolumeInspectResponse{
		Exists:     true,
		Mountpoint: v.Mountpoint,
	}, nil
}
