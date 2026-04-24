package tunnel

import "testing"

func TestIsDeniedPort(t *testing.T) {
	cases := []struct {
		port   int
		denied bool
	}{
		// 允许:常用 HTTP 端口
		{80, false},
		{443, false},
		// 允许:典型应用 / devserver 段
		{1024, false},
		{3000, false},
		{3001, false},
		{5173, false},  // vite
		{8000, false},
		{8080, false},
		{8888, false},
		{9090, false},
		{65535, false},

		// 拒绝:明确清单
		{22, true},    // ssh
		{25, true},    // smtp
		{111, true},   // rpcbind
		{445, true},   // smb
		{465, true},
		{587, true},
		{2375, true},  // docker
		{2376, true},
		{3306, true},  // mysql
		{3389, true},  // rdp
		{5432, true},  // postgres
		{5984, true},  // couchdb
		{6379, true},  // redis
		{9200, true},  // es
		{9300, true},
		{11211, true}, // memcached
		{27017, true},
		{27018, true},

		// 拒绝:所有 <1024 除 80/443
		{1, true},
		{21, true},
		{23, true},
		{53, true},
		{123, true},
		{1023, true},
	}
	for _, c := range cases {
		got := isDeniedPort(c.port)
		if got != c.denied {
			t.Errorf("isDeniedPort(%d) = %v, want %v", c.port, got, c.denied)
		}
	}
}
