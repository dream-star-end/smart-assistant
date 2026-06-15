package containers

import (
	"errors"
	"fmt"
	"testing"
)

// B4:缺失容器识别 —— stop/rm 报 "No such container",inspect/-f 报 "No such object"。
func TestIsDockerNotFound(t *testing.T) {
	yes := []error{
		errors.New("docker stop: exit status 1: Error response from daemon: No such container: abc"),
		errors.New("docker rm: exit status 1: Error: No such container: abc"),
		errors.New("docker inspect: exit status 1: Error: No such object: abc"),
		fmt.Errorf("wrapped: %w", errors.New("No such object: x")),
	}
	for _, e := range yes {
		if !isDockerNotFound(e) {
			t.Errorf("expected not-found for %q", e.Error())
		}
	}
	no := []error{
		nil,
		errors.New("docker stop: exit status 1: Cannot connect to the Docker daemon"),
		errors.New("permission denied"),
		errors.New("No such image: foo"), // 镜像缺失走 ErrImageNotFound,不是容器
	}
	for _, e := range no {
		if isDockerNotFound(e) {
			t.Errorf("did NOT expect not-found for %v", e)
		}
	}
}

func TestMapNotFound(t *testing.T) {
	// 缺失容器 → 包成 ErrContainerNotFound(errors.Is 命中)且保留 detail。
	src := errors.New("docker stop: exit status 1: No such container: c123")
	mapped := mapNotFound(src)
	if !errors.Is(mapped, ErrContainerNotFound) {
		t.Fatalf("expected errors.Is(_, ErrContainerNotFound), got %v", mapped)
	}
	if mapped == nil || mapped.Error() == ErrContainerNotFound.Error() {
		// 应保留底层 detail,而不是只剩 sentinel 文案
		t.Errorf("expected detail preserved, got %q", mapped.Error())
	}

	// 其它错误原样透传(仍走 500)。
	other := errors.New("Cannot connect to the Docker daemon")
	if got := mapNotFound(other); !errors.Is(got, other) || errors.Is(got, ErrContainerNotFound) {
		t.Errorf("non-notfound error should pass through unchanged, got %v", got)
	}

	// nil 透传。
	if mapNotFound(nil) != nil {
		t.Errorf("mapNotFound(nil) should be nil")
	}
}
