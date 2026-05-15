export interface MetricDto {
  key: string;
  label: string;
  value: string;
  delta?: string;
  status?: 'ok' | 'warning' | 'critical';
}

export interface DashboardDto {
  metrics: MetricDto[];
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: 'active' | 'disabled';
  totalEmails?: number;
  unreadEmails?: number;
  gptPlusClaimed?: boolean;
  gptPlusClaimedAt?: string;
  gptPlusStatus?: 'claimed' | 'deactivated';
  gptPlusDeactivatedAt?: string;
  gptPlusDeactivationEmailId?: string;
  initialPassword?: string;
  outlookForwardingAddress?: string;
}

export interface EmailDto {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
}

export interface EmailDetailDto {
  id: string;
  userId: string;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  bodyText: string;
  bodyHtml: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
}

export interface WorkerSettingsDto {
  botStatus: string;
  botTokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  allowedIds: string;
  forwardInbound: boolean;
  targetMode: string;
  defaultChatId: string;
  testChatId: string;
}

export interface MailDomainDto {
  domain: string;
  zoneId: string;
  status: string;
  nameservers: string[];
  isDefault: boolean;
  emailRoutingEnabled: boolean;
  emailRoutingStatus: string;
  lastSetupMessage: string;
  lastSyncedAt: string;
}

export interface OutlookConfigStatusDto {
  graphConfigured: boolean;
  tenantConfigured: boolean;
  clientConfigured: boolean;
  secretConfigured: boolean;
  licenseConfigured: boolean;
  initialDomain: string;
}

export interface OutlookDnsRecordDto {
  type: 'MX' | 'TXT' | 'CNAME';
  name: string;
  value: string;
  priority?: number;
  ttl: string;
  purpose: string;
  required: boolean;
  conflictsWithCloudflareRouting: boolean;
  note: string;
}

export interface OutlookDnsPlanDto {
  domain: string;
  mxTarget: string;
  initialDomain: string;
  graphConfigured: boolean;
  canCreateMailbox: boolean;
  records: OutlookDnsRecordDto[];
  warnings: string[];
  nextSteps: string[];
}

export interface OutlookMailboxResultDto {
  id: string;
  email: string;
  displayName: string;
  initialPassword: string;
  licenseAssigned: boolean;
  message: string;
}

export interface GptPlusClaimDto {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  initialPassword: string;
  claimedAt: string;
  expiresAt: string;
  emailId: string;
  detectedSubject: string;
  detectedSender: string;
  recipient: string;
  status: 'claimed' | 'deactivated';
  deactivatedAt: string;
  deactivationEmailId: string;
  deactivationSubject: string;
  deactivationSender: string;
  dotAliasCount: number;
}

export interface KiroGithubClaimDto {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  initialPassword: string;
  authorizedAt: string;
  emailId: string;
  detectedSubject: string;
  detectedSender: string;
  recipient: string;
  githubUsername: string;
  applicationName: string;
  connectionUrl: string;
  securityLogUrl: string;
}

export interface DotAliasUsageDto {
  email: string;
  used: boolean;
  usedByUserId: string;
  usedByEmail: string;
  source: 'user' | 'alias' | 'gmail' | '';
  provider: string;
}

export interface DotAliasGenerationDto {
  id: string;
  sourceEmail: string;
  provider: string;
  aliasCount: number;
  totalLabel: string;
  truncated: boolean;
  createdBy: string;
  createdAt: string;
  aliases: string[];
  aliasUsage: DotAliasUsageDto[];
}
