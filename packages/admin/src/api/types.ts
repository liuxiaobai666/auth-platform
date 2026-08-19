export interface Paged<T> {
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

export interface AppPolicy {
  kill_switch: boolean;
  kill_message: string | null;
  maintenance: boolean;
  maintenance_message: string | null;
  min_version: string | null;
  latest_version: string | null;
  force_upgrade: boolean;
  upgrade_message: string | null;
  notice_enabled: boolean;
  notice_level: 'info' | 'warning' | 'critical';
  notice_title: string | null;
  notice_content: string | null;
  policy_ttl_seconds: number;
}

export interface Application {
  id: string;
  app_id: string;
  name: string;
  type: string;
  status: 'active' | 'disabled';
  kill_switch: boolean;
  maintenance: boolean;
  latest_version: string | null;
  min_version: string | null;
  remark: string | null;
  counts?: { plugins: number; plans: number; licenses: number };
  policy?: AppPolicy;
  created_at: string;
}

export interface Plan {
  id: string;
  application_id: string;
  app_id?: string;
  code: string;
  name: string;
  duration_days: number | null;
  is_permanent: boolean;
  device_limit: number;
  allow_rebind: boolean;
  rebind_limit: number | null;
  price: number;
  offline_grace_hours: number;
  quota_per_device?: number | null;
  is_count_card?: boolean;
  status: 'active' | 'inactive';
  license_count?: number;
}

export interface Plugin {
  id: string;
  plugin_id: string;
  application_id: string;
  app_id?: string;
  name: string;
  version: string;
  runtime: string;
  endpoint: string | null;
  status: 'draft' | 'testing' | 'active' | 'disabled';
  token_masked: string;
  secret_masked: string;
  prev_secret_expires_at: string | null;
  credentials?: { plugin_token: string; plugin_secret: string };
}

export interface License {
  id: string;
  key_masked: string;
  key_prefix: string;
  app_id?: string;
  plan_code?: string;
  plan_name?: string;
  status: string;
  duration_days: number | null;
  is_permanent: boolean;
  device_limit: number;
  device_count?: number;
  allow_rebind: boolean;
  rebind_limit: number | null;
  rebind_count: number;
  is_count_card?: boolean;
  quota_per_device?: number | null;
  batch_id: string;
  note: string | null;
  activated_at: string | null;
  expires_at: string | null;
  banned_reason: string | null;
  revoked_reason: string | null;
  created_at: string;
  devices?: LicenseDevice[];
  recent_logs?: ActivationLog[];
}

export interface LicenseDevice {
  id: string;
  device_id: string;
  device_name: string | null;
  client_version: string | null;
  status: 'active' | 'unbound';
  quota_total?: number | null;
  quota_used?: number;
  quota_reserved?: number;
  quota_available?: number | null;
  first_seen_at: string;
  last_seen_at: string;
  last_ip: string | null;
  unbound_reason: string | null;
}

export interface ActivationLog {
  action: string;
  success: boolean;
  code: string | null;
  device_id: string | null;
  ip: string | null;
  client_version: string | null;
  created_at: string;
}

export interface Release {
  id: string;
  app_id?: string;
  version: string;
  channel: 'stable' | 'beta';
  status: 'draft' | 'published' | 'archived';
  file_name: string | null;
  file_size: number | null;
  sha256: string | null;
  external_url: string | null;
  release_notes: string | null;
  is_mandatory: boolean;
  rollout_percent: number;
  download_count: number;
  published_at: string | null;
}
