-- OCV5-289 test-only, session-local schema mirror from selfhost public DDL.
-- CI uses this when the dedicated test DB has no migrated public tables.
-- Never apply this file to a persistent schema or production connection.
-- All statements are CREATE TEMP TABLE; they vanish with the test session.

CREATE TEMP TABLE request_finalize_journal (
    request_id text NOT NULL,
    user_id bigint NOT NULL,
    container_id bigint,
    state text DEFAULT 'inflight'::text NOT NULL,
    ctx jsonb NOT NULL,
    precheck_credits bigint NOT NULL,
    final_credits bigint,
    ledger_id bigint,
    usage_id bigint,
    error_msg text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_code text,
    dispatch_id uuid,
    attempt_no integer,
    CONSTRAINT request_finalize_journal_failure_code_check CHECK ((failure_code = ANY (ARRAY['UNKNOWN'::text, 'INVALID_REQUEST'::text, 'RATE_LIMITED'::text, 'UPSTREAM_UNAVAILABLE'::text, 'UPSTREAM_REJECTED'::text, 'CLIENT_ABORT'::text, 'STREAM_FAILED'::text, 'BILLING_FAILED'::text, 'INTERNAL_ERROR'::text, 'USER_CANCELLED'::text]))),
    CONSTRAINT request_finalize_journal_state_check CHECK ((state = ANY (ARRAY['inflight'::text, 'finalizing'::text, 'committed'::text, 'aborted'::text])))
);
CREATE TEMP TABLE usage_records (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    session_id text,
    mode text NOT NULL,
    account_id bigint,
    model text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    price_snapshot jsonb NOT NULL,
    cost_credits bigint NOT NULL,
    ledger_id bigint,
    request_id text NOT NULL,
    status text NOT NULL,
    error_msg text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_session_id text,
    delegate_agent_id text,
    org_id bigint,
    execution_revision text,
    projection_revision text,
    security_epoch bigint,
    authority_kind text,
    turn_key text,
    parent_turn_key text,
    dispatch_id uuid,
    attempt_no integer,
    verification_run_id uuid,
    would_have_cost_credits bigint,
    board_project_id text,
    board_project_source text,
    board_project_captured_at timestamp with time zone,
    api_key_id bigint,
    CONSTRAINT usage_records_authority_kind_check CHECK (((authority_kind IS NULL) OR (authority_kind = ANY (ARRAY['bridge_signed'::text, 'local_catalog'::text])))),
    CONSTRAINT usage_records_mode_check CHECK ((mode = ANY (ARRAY['chat'::text, 'agent'::text, 'delegate'::text]))),
    CONSTRAINT usage_records_parent_turn_key_check CHECK (((parent_turn_key IS NULL) OR (parent_turn_key ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT usage_records_status_check CHECK ((status = ANY (ARRAY['success'::text, 'billing_failed'::text, 'error'::text]))),
    CONSTRAINT usage_records_turn_key_check CHECK (((turn_key IS NULL) OR (turn_key ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT usage_records_verification_pair_check CHECK ((((verification_run_id IS NULL) AND (would_have_cost_credits IS NULL)) OR ((verification_run_id IS NOT NULL) AND (would_have_cost_credits IS NOT NULL) AND (cost_credits = 0)))),
    CONSTRAINT usage_records_would_have_cost_credits_check CHECK ((would_have_cost_credits >= 0))
);
CREATE TEMP TABLE pending_usage_patches (
    request_id text NOT NULL,
    user_id text NOT NULL,
    session_id text,
    parent_session_id text,
    delegate_agent_id text,
    cost_credits text NOT NULL,
    created_at bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)))::bigint NOT NULL,
    turn_key text,
    parent_turn_key text
);
CREATE TEMP TABLE users (
    id bigint NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    password_hash text NOT NULL,
    display_name text,
    avatar_url text,
    role text DEFAULT 'user'::text NOT NULL,
    credits bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned_host_uuid uuid,
    v5_migrated_at timestamp with time zone,
    v5_migration_status text,
    free_bootstrap_settled boolean DEFAULT false NOT NULL,
    terms_version text,
    terms_accepted_at timestamp with time zone,
    signal_traffic_class text DEFAULT 'production_user'::text NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text]))),
    CONSTRAINT users_signal_traffic_class_check CHECK ((signal_traffic_class = ANY (ARRAY['production_user'::text, 'internal_admin'::text, 'synthetic_canary'::text, 'e2e'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'banned'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT users_v5_migrated_consistency_check CHECK (((v5_migrated_at IS NOT NULL) = (NOT (v5_migration_status IS DISTINCT FROM 'migrated'::text)))),
    CONSTRAINT users_v5_migration_status_check CHECK ((v5_migration_status = ANY (ARRAY['seeding'::text, 'migrating'::text, 'migrated'::text, 'rolled_back'::text])))
);
CREATE TEMP TABLE user_subscriptions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    plan_code text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    period_start timestamp with time zone DEFAULT now() NOT NULL,
    period_end timestamp with time zone NOT NULL,
    period_credits bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_subscriptions_period_credits_check CHECK ((period_credits >= 0)),
    CONSTRAINT user_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text])))
);
CREATE TEMP TABLE org_memberships (
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    org_role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    billing_enabled boolean DEFAULT true NOT NULL,
    invited_by bigint,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    billing_delegate boolean DEFAULT false NOT NULL,
    monthly_org_budget bigint,
    CONSTRAINT org_memberships_monthly_org_budget_check CHECK (((monthly_org_budget IS NULL) OR (monthly_org_budget > 0))),
    CONSTRAINT org_memberships_org_role_check CHECK ((org_role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT org_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);
CREATE TEMP TABLE orgs (
    id bigint NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    credits bigint DEFAULT 0 NOT NULL,
    max_members integer DEFAULT 100 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    low_balance_notified_at timestamp with time zone,
    CONSTRAINT orgs_max_members_check CHECK ((max_members > 0)),
    CONSTRAINT orgs_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200))),
    CONSTRAINT orgs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleting'::text, 'deleted'::text])))
);
CREATE TEMP TABLE org_subscriptions (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    plan_code text NOT NULL,
    seats integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    period_start timestamp with time zone DEFAULT now() NOT NULL,
    period_end timestamp with time zone NOT NULL,
    period_credits bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_subscriptions_period_credits_check CHECK ((period_credits >= 0)),
    CONSTRAINT org_subscriptions_seats_check CHECK ((seats > 0)),
    CONSTRAINT org_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text])))
);
CREATE TEMP TABLE turn_waivers (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    turn_key text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    refunded_credits bigint DEFAULT 0 NOT NULL,
    record_count integer DEFAULT 0 NOT NULL,
    inbox_message_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT turn_waivers_check CHECK ((((status = 'pending'::text) AND (applied_at IS NULL) AND (inbox_message_id IS NULL)) OR ((status = 'applied'::text) AND (applied_at IS NOT NULL) AND (inbox_message_id IS NOT NULL)))),
    CONSTRAINT turn_waivers_reason_check CHECK ((reason = ANY (ARRAY['idle_timeout'::text, 'no_response'::text, 'platform_authority_expired'::text, 'turn_limit'::text]))),
    CONSTRAINT turn_waivers_record_count_check CHECK ((record_count >= 0)),
    CONSTRAINT turn_waivers_refunded_credits_check CHECK ((refunded_credits >= 0)),
    CONSTRAINT turn_waivers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text]))),
    CONSTRAINT turn_waivers_turn_key_check CHECK ((turn_key ~ '^[0-9a-f]{64}$'::text))
);
CREATE TEMP TABLE client_sessions (
    id text NOT NULL,
    user_id text DEFAULT 'default'::text NOT NULL,
    agent_id text DEFAULT 'main'::text NOT NULL,
    title text DEFAULT '新会话'::text NOT NULL,
    pinned smallint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    last_at bigint NOT NULL,
    messages text DEFAULT '[]'::text NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint,
    next_seq integer DEFAULT 1 NOT NULL,
    origin_channel text,
    archived_through_seq integer DEFAULT 0 NOT NULL,
    archived_count integer DEFAULT 0 NOT NULL,
    model_id text,
    history_revision bigint DEFAULT 0 NOT NULL,
    timeline_generation bigint DEFAULT 1 NOT NULL,
    workspace_mode text DEFAULT 'isolated_v1'::text NOT NULL,
    project_id text,
    archived_at bigint,
    last_read_at bigint,
    CONSTRAINT client_sessions_archived_count_check CHECK ((archived_count >= 0)),
    CONSTRAINT client_sessions_archived_through_seq_check CHECK ((archived_through_seq >= 0)),
    CONSTRAINT client_sessions_history_revision_check CHECK ((history_revision >= 0)),
    CONSTRAINT client_sessions_message_count_check CHECK ((message_count >= 0)),
    CONSTRAINT client_sessions_next_seq_check CHECK ((next_seq >= 1)),
    CONSTRAINT client_sessions_pinned_check CHECK ((pinned = ANY (ARRAY[0, 1]))),
    CONSTRAINT client_sessions_timeline_generation_check CHECK ((timeline_generation >= 1)),
    CONSTRAINT client_sessions_workspace_mode_check CHECK ((workspace_mode = ANY (ARRAY['legacy'::text, 'isolated_v1'::text])))
);
CREATE TEMP TABLE chat_projects (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    instructions text,
    color text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint,
    board_project_id text,
    is_research_default boolean DEFAULT false NOT NULL
);
CREATE TEMP TABLE credit_ledger (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    delta bigint NOT NULL,
    balance_after bigint NOT NULL,
    reason text NOT NULL,
    ref_type text,
    ref_id text,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    bucket text DEFAULT 'wallet'::text NOT NULL,
    org_id bigint,
    CONSTRAINT ck_cl_org_wallet_has_org CHECK (((bucket <> ALL (ARRAY['org_wallet'::text, 'org_period'::text])) OR (org_id IS NOT NULL))),
    CONSTRAINT credit_ledger_bucket_check CHECK ((bucket = ANY (ARRAY['wallet'::text, 'period'::text, 'org_wallet'::text, 'org_period'::text]))),
    CONSTRAINT credit_ledger_reason_check CHECK ((reason = ANY (ARRAY['topup'::text, 'chat'::text, 'agent_chat'::text, 'agent_subscription'::text, 'refund'::text, 'admin_adjust'::text, 'promotion'::text, 'minimax_media'::text, 'image_generation'::text, 'subscription'::text, 'subscription_expire'::text, 'pack'::text])))
);

-- The recovery path relies on these durable uniqueness fences. Reproduce
-- them in the isolated fixture instead of letting an empty test DB go green.
ALTER TABLE request_finalize_journal ADD PRIMARY KEY (request_id);
ALTER TABLE users ADD PRIMARY KEY (id);
ALTER TABLE usage_records ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX usage_records_user_request_test_uq ON usage_records (user_id, request_id);
ALTER TABLE pending_usage_patches ADD PRIMARY KEY (request_id);
CREATE UNIQUE INDEX pending_usage_request_user_test_uq ON pending_usage_patches (request_id, user_id);
ALTER TABLE credit_ledger ADD PRIMARY KEY (id);
ALTER TABLE user_subscriptions ADD PRIMARY KEY (id);
ALTER TABLE orgs ADD PRIMARY KEY (id);
ALTER TABLE org_subscriptions ADD PRIMARY KEY (id);
