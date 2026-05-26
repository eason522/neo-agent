export type PermissionBehavior = 'allow' | 'ask' | 'deny';

export type PermissionDomain = 'file' | 'mcp' | 'web' | 'hook';

export type PermissionDecision = {
  domain: PermissionDomain;
  behavior: PermissionBehavior;
  code: string;
  reason: string;
  subject: string;
  source?: 'config' | 'runtime' | 'workspace' | 'tool_hint' | 'user';
  metadata?: Record<string, unknown>;
};

export type PermissionRuleInput = {
  domain?: PermissionDomain;
  subject: string;
  aliases?: string[];
  allowRules?: string[];
  denyRules?: string[];
};

export type FileWritePermissionInput = {
  toolName: string;
  path: string;
  operation: 'create' | 'overwrite' | 'edit' | 'mkdir' | 'copy' | 'move' | 'delete';
  permissionRequired: boolean;
  interactive: boolean;
};

export type McpToolPermissionInput = {
  fullName: string;
  qualifiedName: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  mode: 'readOnly' | 'allowAll';
  allowedTools: string[];
  deniedTools: string[];
};

export type WebHostnamePermissionInput = {
  hostname: string;
  blockedByPrivateAddress: boolean;
  blockedByDomainRule: boolean;
  constrainedByAllowedDomains: boolean;
  allowedByDomainRule: boolean;
  operation: string;
};

export function allowPermission(input: Omit<PermissionDecision, 'behavior'>): PermissionDecision {
  return { ...input, behavior: 'allow' };
}

export function askPermission(input: Omit<PermissionDecision, 'behavior'>): PermissionDecision {
  return { ...input, behavior: 'ask' };
}

export function denyPermission(input: Omit<PermissionDecision, 'behavior'>): PermissionDecision {
  return { ...input, behavior: 'deny' };
}

export function assertPermissionAllowed(decision: PermissionDecision): void {
  if (decision.behavior !== 'allow') throw new Error(decision.reason);
}

export function evaluateRulePermission(input: PermissionRuleInput): PermissionDecision | undefined {
  const domain = input.domain ?? 'mcp';
  const subjects = [input.subject, ...(input.aliases ?? [])];
  const deniedBy = matchPermissionRule(subjects, input.denyRules ?? []);
  if (deniedBy) {
    return denyPermission({
      domain,
      subject: input.subject,
      code: 'explicit_denied',
      source: 'config',
      reason: `已被配置拒绝：${input.subject}`,
      metadata: { matchedRule: deniedBy }
    });
  }

  const allowedBy = matchPermissionRule(subjects, input.allowRules ?? []);
  if (allowedBy) {
    return allowPermission({
      domain,
      subject: input.subject,
      code: 'explicit_allowed',
      source: 'config',
      reason: '显式允许',
      metadata: { matchedRule: allowedBy }
    });
  }

  return undefined;
}

export function evaluateFileWritePermission(input: FileWritePermissionInput): PermissionDecision {
  if (!input.permissionRequired) {
    return allowPermission({
      domain: 'file',
      subject: input.path,
      code: 'workspace_allowed',
      source: 'workspace',
      reason: 'workspace 内写入已允许',
      metadata: { toolName: input.toolName, operation: input.operation }
    });
  }

  if (!input.interactive) {
    return denyPermission({
      domain: 'file',
      subject: input.path,
      code: 'needs_interactive_permission',
      source: 'runtime',
      reason: `文件写入需要交互式权限确认：${input.path}`,
      metadata: { toolName: input.toolName, operation: input.operation }
    });
  }

  return askPermission({
    domain: 'file',
    subject: input.path,
    code: 'needs_user_permission',
    source: 'runtime',
    reason: `文件写入需要用户确认：${input.path}`,
    metadata: { toolName: input.toolName, operation: input.operation }
  });
}

export function evaluateMcpPermission(input: McpToolPermissionInput): PermissionDecision {
  const ruleDecision = evaluateRulePermission({
    subject: input.fullName,
    aliases: [input.qualifiedName],
    allowRules: input.allowedTools,
    denyRules: input.deniedTools
  });
  if (ruleDecision) {
    return {
      ...ruleDecision,
      domain: 'mcp',
      subject: input.fullName,
      reason: ruleDecision.behavior === 'deny'
        ? `MCP 工具已被配置拒绝：${input.fullName}`
        : ruleDecision.reason
    };
  }

  if (input.mode === 'allowAll') {
    return allowPermission({
      domain: 'mcp',
      subject: input.fullName,
      code: 'allow_all',
      source: 'config',
      reason: '权限模式允许所有 MCP 工具'
    });
  }

  if (input.readOnlyHint === true && input.destructiveHint !== true) {
    return allowPermission({
      domain: 'mcp',
      subject: input.fullName,
      code: 'read_only',
      source: 'tool_hint',
      reason: '只读 MCP 工具'
    });
  }

  return askPermission({
    domain: 'mcp',
    subject: input.fullName,
    code: 'needs_user_permission',
    source: 'runtime',
    reason: [
      `MCP 工具未获授权：${input.fullName}`,
      '默认只自动执行 readOnly 且非 destructive 的 MCP 工具。',
      `如确认需要允许，请在 ~/.neo-agent/config.json 的 mcp.permissions.allowedTools 加入 "${input.fullName}"，`,
      `或运行 \`neo mcp permission allow ${input.fullName}\`；也可临时设置 NEO_AGENT_MCP_PERMISSION_MODE=allowAll。`
    ].join(' ')
  });
}

export function evaluateWebHostnamePermission(input: WebHostnamePermissionInput): PermissionDecision {
  if (input.blockedByPrivateAddress) {
    return denyPermission({
      domain: 'web',
      subject: input.hostname,
      code: 'private_address_blocked',
      source: 'config',
      reason: `${input.operation} 已阻止访问本地、内网或链路本地地址：${input.hostname}`
    });
  }

  if (input.blockedByDomainRule) {
    return denyPermission({
      domain: 'web',
      subject: input.hostname,
      code: 'blocked_domain',
      source: 'config',
      reason: `${input.operation} 已被 blockedDomains 拒绝：${input.hostname}`
    });
  }

  if (input.constrainedByAllowedDomains && !input.allowedByDomainRule) {
    return denyPermission({
      domain: 'web',
      subject: input.hostname,
      code: 'outside_allowed_domains',
      source: 'config',
      reason: `${input.operation} 不在 allowedDomains 范围内：${input.hostname}`
    });
  }

  return allowPermission({
    domain: 'web',
    subject: input.hostname,
    code: 'allowed',
    source: 'config',
    reason: `${input.operation} 域名策略允许访问`
  });
}

export function matchPermissionRule(subjects: string[], rules: string[]): string | undefined {
  const normalizedSubjects = subjects.map(subject => subject.trim()).filter(Boolean);
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    if (normalizedSubjects.some(subject => permissionRuleMatchesSubject(subject, trimmed))) return trimmed;
  }
  return undefined;
}

function permissionRuleMatchesSubject(subject: string, rule: string): boolean {
  if (rule === subject) return true;
  if (rule.endsWith('*')) return subject.startsWith(rule.slice(0, -1));
  return false;
}
