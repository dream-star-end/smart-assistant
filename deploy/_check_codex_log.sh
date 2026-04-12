#!/bin/bash
grep -A1 'oauth.*codex\|oauth.*token exchange failed' /var/log/openclaude.log | tail -20
