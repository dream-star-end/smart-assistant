#!/bin/bash
systemctl restart openclaude && sleep 2 && echo -n "status: " && systemctl is-active openclaude
