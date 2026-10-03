create table if not exists users (
  id text primary key,
  email text not null unique,
  display_name text not null,
  home_currency text not null default 'USD',
  suspended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id),
  expires_at timestamptz not null
);

create table if not exists magic_links (
  token_hash text primary key,
  email text not null,
  purpose text not null,
  user_id text,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists participants (
  id text primary key,
  display_name text not null,
  email text,
  user_id text unique references users(id),
  created_at timestamptz not null default now()
);

create table if not exists groups (
  id text primary key,
  name text not null,
  settlement_currency text not null,
  timezone text not null,
  simplify boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  group_id text not null references groups(id) on delete cascade,
  participant_id text not null references participants(id),
  default_weight integer,
  muted boolean not null default false,
  removed_at timestamptz,
  primary key (group_id, participant_id)
);

create table if not exists categories (
  id text primary key,
  group_id text references groups(id) on delete cascade,
  label text not null,
  fixed boolean not null default false
);

create table if not exists expenses (
  id text primary key,
  group_id text not null references groups(id),
  expense_date text not null,
  description text not null,
  category_id text not null,
  kind text not null,
  original_currency text not null,
  original_minor integer not null,
  settlement_minor integer not null,
  rate text,
  overridden boolean not null default false,
  version integer not null default 1,
  recurrence_id text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists expense_lines (
  expense_id text not null references expenses(id) on delete cascade,
  participant_id text not null,
  role text not null,
  minor integer not null,
  primary key (expense_id, participant_id, role)
);

create table if not exists expense_items (
  id text primary key,
  expense_id text not null references expenses(id) on delete cascade,
  label text not null,
  minor integer not null,
  position integer not null
);

create table if not exists expense_item_people (
  item_id text not null references expense_items(id) on delete cascade,
  participant_id text not null,
  primary key (item_id, participant_id)
);

create table if not exists expense_extras (
  expense_id text primary key references expenses(id) on delete cascade,
  tax_minor integer not null default 0,
  tip_minor integer not null default 0,
  discount_minor integer not null default 0
);

create table if not exists settlements (
  id text primary key,
  group_id text not null references groups(id),
  settlement_date text not null,
  from_participant_id text not null,
  to_participant_id text not null,
  minor integer not null,
  note text not null default '',
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists activity (
  id text primary key,
  group_id text not null,
  actor_participant_id text,
  kind text not null,
  summary text not null,
  payload text not null,
  created_at timestamptz not null default now()
);

create table if not exists comments (
  id text primary key,
  group_id text not null,
  target_type text not null,
  target_id text not null,
  author_participant_id text not null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists notifications (
  id text primary key,
  user_id text not null,
  kind text not null,
  title text not null,
  body text not null,
  group_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists invites (
  id text primary key,
  group_id text not null,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists blocks (
  blocker_user_id text not null,
  blocked_user_id text not null,
  primary key (blocker_user_id, blocked_user_id)
);

create table if not exists nudges (
  id text primary key,
  group_id text not null,
  from_user_id text not null,
  to_participant_id text not null,
  nudge_date text not null,
  unique (group_id, from_user_id, to_participant_id, nudge_date)
);

create table if not exists recurrences (
  id text primary key,
  group_id text not null,
  description text not null,
  category_id text not null,
  kind text not null,
  settlement_minor integer not null,
  payers text not null,
  shares text not null,
  frequency text not null,
  start_date text not null,
  next_date text not null,
  end_date text,
  paused boolean not null default false,
  pause_reason text
);

create table if not exists reports (
  id text primary key,
  reporter_user_id text not null,
  target_type text not null,
  target_id text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists outbound_emails (
  id text primary key,
  to_email text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists images (
  id text primary key,
  expense_id text not null,
  content_type text not null,
  data_base64 text not null,
  created_at timestamptz not null default now()
);

create table if not exists fx_rates (
  base text not null,
  quote text not null,
  rate_date text not null,
  rate text not null,
  primary key (base, quote, rate_date)
);

create index if not exists memberships_participant on memberships(participant_id);
create index if not exists expenses_group on expenses(group_id);
create index if not exists activity_group on activity(group_id, created_at);
