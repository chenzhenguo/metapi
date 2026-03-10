import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api.js';
import { BrandGlyph, InlineBrandIcon, getBrand, hashColor, normalizeBrandIconKey, type BrandInfo } from '../components/BrandIcon.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { tr } from '../i18n.js';
import {
  buildRouteModelCandidatesIndex,
  type RouteCandidateView,
  type RouteModelCandidatesByModelName,
} from './helpers/routeModelCandidatesIndex.js';
import { getInitialVisibleCount, getNextVisibleCount } from './helpers/progressiveRender.js';
import {
  buildRouteMissingTokenIndex,
  normalizeMissingTokenModels,
  type MissingTokenModelsByName,
} from './helpers/routeMissingTokenHints.js';
import { buildVisibleRouteList } from './helpers/routeListVisibility.js';

type RouteSortBy = 'modelPattern' | 'channelCount';
type RouteSortDir = 'asc' | 'desc';
type GroupFilter = null | '__all__' | number;

type RouteChannelDraft = {
  accountId: number;
  tokenId: number;
  sourceModel: string;
};

type RouteChannel = {
  id: number;
  accountId: number;
  tokenId: number | null;
  sourceModel?: string | null;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
  successCount: number;
  failCount: number;
  cooldownUntil?: string | null;
  account?: {
    username: string | null;
  };
  site?: {
    id: number;
    name: string | null;
    platform: string | null;
  };
  token?: {
    id: number;
    name: string;
    accountId: number;
    enabled: boolean;
    isDefault: boolean;
  } | null;
};

type RouteRow = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  displayIcon?: string | null;
  modelMapping?: string | null;
  decisionSnapshot?: RouteDecision | null;
  decisionRefreshedAt?: string | null;
  enabled: boolean;
  channels: RouteChannel[];
};

type RouteDecisionCandidate = {
  channelId: number;
  accountId: number;
  username: string;
  siteName: string;
  tokenName: string;
  priority: number;
  weight: number;
  eligible: boolean;
  recentlyFailed: boolean;
  avoidedByRecentFailure: boolean;
  probability: number;
  reason: string;
};

type RouteDecision = {
  requestedModel: string;
  actualModel: string;
  matched: boolean;
  selectedChannelId?: number;
  selectedLabel?: string;
  summary: string[];
  candidates: RouteDecisionCandidate[];
};

type ChannelDecisionState = {
  probability: number;
  showBar: boolean;
  reasonText: string;
  reasonColor: string;
};

type RouteTokenOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

type RouteIconOption = {
  value: string;
  label: string;
  description?: string;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

type MissingTokenRouteSiteActionItem = {
  key: string;
  siteName: string;
  accountId: number;
  accountLabel: string;
};

type SortableChannelRowProps = {
  channel: RouteChannel;
  decisionCandidate?: RouteDecisionCandidate;
  isExactRoute: boolean;
  loadingDecision: boolean;
  isSavingPriority: boolean;
  tokenOptions: RouteTokenOption[];
  activeTokenId: number;
  isUpdatingToken: boolean;
  onTokenDraftChange: (channelId: number, tokenId: number) => void;
  onSaveToken: () => void;
  onDeleteChannel: () => void;
};

const AUTO_ROUTE_DECISION_LIMIT = 80;
const ROUTE_RENDER_CHUNK = 40;
const ROUTE_BRAND_ICON_PREFIX = 'brand:';
const EMPTY_ROUTE_CANDIDATE_VIEW: RouteCandidateView = {
  routeCandidates: [],
  accountOptions: [],
  tokenOptionsByAccountId: {},
};
const ROUTE_ICON_OPTIONS: RouteIconOption[] = [
  { value: '', label: '自动品牌图标', description: '按模型匹配规则自动识别品牌', iconText: '✦' },
];
const ENDPOINT_TYPE_ICON_MODEL_MAP: Record<string, string> = {
  openai: 'chatgpt',
  gemini: 'gemini',
  anthropic: 'claude',
  anthroic: 'claude',
  claude: 'claude',
};
const PLATFORM_ENDPOINT_FALLBACK_MAP: Record<string, string[]> = {
  openai: ['openai'],
  'new-api': ['openai'],
  'one-api': ['openai'],
  'one-hub': ['openai'],
  'done-hub': ['openai'],
  sub2api: ['openai'],
  veloera: ['openai'],
  cliproxyapi: ['openai'],
  claude: ['anthropic'],
  gemini: ['gemini'],
  anyrouter: ['openai', 'anthropic'],
};
const PLATFORM_ALIASES: Record<string, string> = {
  anthropic: 'claude',
  google: 'gemini',
  'new api': 'new-api',
  newapi: 'new-api',
  'one api': 'one-api',
  oneapi: 'one-api',
};

function isRegexModelPattern(modelPattern: string): boolean {
  return modelPattern.trim().toLowerCase().startsWith('re:');
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (isRegexModelPattern(normalized)) return false;
  return !/[\*\?\[]/.test(normalized);
}

function parseRegexModelPattern(modelPattern: string): { regex: RegExp | null; error: string | null } {
  if (!isRegexModelPattern(modelPattern)) return { regex: null, error: null };
  const body = modelPattern.trim().slice(3).trim();
  if (!body) return { regex: null, error: 're: 后缺少正则表达式' };
  try {
    return { regex: new RegExp(body), error: null };
  } catch (error) {
    return { regex: null, error: (error as Error)?.message || '无效正则' };
  }
}

function globToRegexSource(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      source += '.*';
      continue;
    }
    if (ch === '?') {
      source += '.';
      continue;
    }
    if (ch === '[') {
      const closeIndex = glob.indexOf(']', i + 1);
      if (closeIndex > i + 1) {
        source += glob.slice(i, closeIndex + 1);
        i = closeIndex;
        continue;
      }
      source += '\\[';
      continue;
    }
    source += ch.replace(/[\\^$+?.()|{}]/g, '\\$&');
  }
  return source;
}

function matchesGlobPattern(model: string, pattern: string): boolean {
  try {
    return new RegExp(`^${globToRegexSource(pattern)}$`).test(model);
  } catch {
    return false;
  }
}

function matchesModelPattern(model: string, pattern: string): boolean {
  const normalized = (pattern || '').trim();
  if (!normalized) return false;
  if (normalized === model) return true;

  if (isRegexModelPattern(normalized)) {
    const parsed = parseRegexModelPattern(normalized);
    return !!parsed.regex && parsed.regex.test(model);
  }

  return matchesGlobPattern(model, normalized);
}

function getModelPatternError(modelPattern: string): string | null {
  const normalized = modelPattern.trim();
  if (!normalized) return null;
  if (!isRegexModelPattern(normalized)) return null;
  const parsed = parseRegexModelPattern(normalized);
  if (!parsed.error) return null;
  return `模型匹配正则错误：${parsed.error}`;
}

function resolveRouteTitle(route: RouteRow): string {
  const title = (route.displayName || '').trim();
  return title || route.modelPattern;
}

function resolveRouteBrand(route: Pick<RouteRow, 'displayName' | 'modelPattern'>): BrandInfo | null {
  const displayName = (route.displayName || '').trim();
  if (displayName) {
    const byDisplayName = getBrand(displayName);
    if (byDisplayName) return byDisplayName;
  }
  return getBrand(route.modelPattern);
}

function toBrandIconValue(icon: string): string {
  return `${ROUTE_BRAND_ICON_PREFIX}${icon}`;
}

function parseBrandIconValue(raw: string): string | null {
  const normalized = (raw || '').trim();
  if (!normalized.startsWith(ROUTE_BRAND_ICON_PREFIX)) return null;
  const icon = normalized.slice(ROUTE_BRAND_ICON_PREFIX.length).trim();
  return normalizeBrandIconKey(icon);
}

function normalizeRouteDisplayIconValue(raw: string | null | undefined): string {
  const normalized = (raw || '').trim();
  const brandIcon = parseBrandIconValue(normalized);
  if (brandIcon) return toBrandIconValue(brandIcon);
  return normalized;
}

function resolveEndpointTypeIconModel(endpointType: string): string | null {
  const key = String(endpointType || '').trim().toLowerCase();
  if (!key) return null;
  return ENDPOINT_TYPE_ICON_MODEL_MAP[key] || null;
}

function normalizePlatformKey(platform: string | null | undefined): string {
  const raw = String(platform || '').trim().toLowerCase();
  if (!raw) return '';
  return PLATFORM_ALIASES[raw] || raw;
}

function inferEndpointTypesFromPlatform(platform: string | null | undefined): string[] {
  const key = normalizePlatformKey(platform);
  if (!key) return [];
  const mapped = PLATFORM_ENDPOINT_FALLBACK_MAP[key];
  if (Array.isArray(mapped) && mapped.length > 0) return mapped;

  if (key.includes('claude') || key.includes('anthropic')) return ['anthropic'];
  if (key.includes('gemini')) return ['gemini'];
  if (key.includes('openai') || key.includes('new-api') || key.includes('one-api')) return ['openai'];
  return [];
}

function siteAvatarLetters(siteName: string): string {
  const normalized = String(siteName || '').trim();
  if (!normalized) return 'S';
  const parts = normalized.replace(/[-_/.]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const compact = normalized.replace(/\s+/g, '');
  return compact.slice(0, 2).toUpperCase();
}

function resolveRouteIcon(route: RouteRow): { kind: 'none' } | { kind: 'text'; value: string } | { kind: 'brand'; value: string } {
  const icon = (route.displayIcon || '').trim();
  if (!icon) return { kind: 'none' };
  const brandIcon = parseBrandIconValue(icon);
  if (brandIcon) return { kind: 'brand', value: brandIcon };
  return { kind: 'text', value: icon };
}

function normalizeRoutes(routeRows: any[]): RouteRow[] {
  return (routeRows || []).map((route) => {
    const channels = [...((route.channels || []) as RouteChannel[])].sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa === pb) return (a.id ?? 0) - (b.id ?? 0);
      return pa - pb;
    });

    return {
      ...(route as RouteRow),
      channels,
    };
  });
}

function buildSourceGroupKey(routeId: number, sourceModel: string): string {
  const normalizedSourceModel = sourceModel.trim() || '__ungrouped__';
  return `${routeId}::${normalizedSourceModel}`;
}

function getPriorityTagStyle(priority: number): CSSProperties {
  if (priority <= 0) {
    return {
      background: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
      color: 'var(--color-success)',
    };
  }

  if (priority === 1) {
    return {
      background: 'color-mix(in srgb, var(--color-info) 16%, transparent)',
      color: 'var(--color-info)',
    };
  }

  return {
    background: 'rgba(100,116,139,0.18)',
    color: 'var(--color-text-secondary)',
  };
}

function getProbabilityColor(probability: number): string {
  if (probability >= 80) return 'var(--color-success)';
  if (probability >= 60) return 'color-mix(in srgb, var(--color-success) 50%, var(--color-warning))';
  if (probability >= 40) return 'var(--color-warning)';
  if (probability >= 20) return 'color-mix(in srgb, var(--color-warning) 45%, var(--color-danger))';
  if (probability > 0) return 'var(--color-danger)';
  return 'var(--color-border)';
}

function getChannelDecisionState(
  candidate: RouteDecisionCandidate | undefined,
  channel: RouteChannel,
  isExactRoute: boolean,
  loadingDecision: boolean,
): ChannelDecisionState {
  if (!isExactRoute && !candidate) {
    return {
      probability: 0,
      showBar: true,
      reasonText: loadingDecision ? '计算中...' : '实时决策',
      reasonColor: 'var(--color-text-muted)',
    };
  }

  if (!candidate) {
    return {
      probability: 0,
      showBar: true,
      reasonText: loadingDecision ? '计算中...' : '无可用通道',
      reasonColor: 'var(--color-text-muted)',
    };
  }

  if (candidate.avoidedByRecentFailure) {
    return {
      probability: 0,
      showBar: true,
      reasonText: '失败避让',
      reasonColor: 'var(--color-warning)',
    };
  }

  if (!candidate.eligible) {
    const nowIso = new Date().toISOString();
    const cooldownActive = !!channel.cooldownUntil && channel.cooldownUntil > nowIso;
    if (cooldownActive || candidate.reason.includes('冷却中')) {
      return {
        probability: 0,
        showBar: true,
        reasonText: '冷却中',
        reasonColor: 'var(--color-danger)',
      };
    }

    return {
      probability: 0,
      showBar: true,
      reasonText: candidate.reason || '不可用',
      reasonColor: 'var(--color-text-muted)',
    };
  }

  const probability = Number(candidate.probability || 0);
  if (probability <= 0) {
    if (candidate.recentlyFailed) {
      return {
        probability: 0,
        showBar: false,
        reasonText: '近期失败',
        reasonColor: 'var(--color-warning)',
      };
    }

    return {
      probability: 0,
      showBar: false,
      reasonText: candidate.reason || '概率为 0%',
      reasonColor: 'var(--color-text-muted)',
    };
  }

  return {
    probability,
    showBar: true,
    reasonText: '',
    reasonColor: 'var(--color-text-muted)',
  };
}

function SortableChannelRow({
  channel,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
}: SortableChannelRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: channel.id,
    disabled: isSavingPriority,
  });

  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.72 : 1,
    zIndex: isDragging ? 10 : 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderLeft: '2px solid var(--color-primary)',
    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
    background: isDragging ? 'rgba(59,130,246,0.08)' : 'rgba(79,70,229,0.02)',
    boxShadow: isDragging ? 'var(--shadow-sm)' : 'none',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);

  return (
    <div ref={setNodeRef} style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={isSavingPriority}
          className="btn btn-ghost"
          style={{
            width: 22,
            minWidth: 22,
            height: 22,
            padding: 0,
            border: '1px solid var(--color-border-light)',
            color: 'var(--color-text-muted)',
            cursor: isSavingPriority ? 'not-allowed' : 'grab',
          }}
          data-tooltip="拖拽调整优先级"
          aria-label="拖拽调整优先级"
        >
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
            <circle cx="3" cy="2" r="1" />
            <circle cx="9" cy="2" r="1" />
            <circle cx="3" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
            <circle cx="3" cy="10" r="1" />
            <circle cx="9" cy="10" r="1" />
          </svg>
        </button>

        <span
          className="badge"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.1,
            ...getPriorityTagStyle(channel.priority ?? 0),
          }}
        >
          P{channel.priority ?? 0}
        </span>

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <span className="badge badge-muted" style={{ fontSize: 10 }}>
          {channel.site?.name || 'unknown'}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: 'color-mix(in srgb, var(--color-info) 15%, transparent)',
            color: 'var(--color-info)',
          }}
        >
          {channel.token?.name || '默认令牌'}
        </span>

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip="该通道由用户手动添加，而非系统自动生成"
          >
            手动配置
          </span>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
            <div
              data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
              style={{
                width: 80,
                height: 6,
                background: 'var(--color-border)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                  height: '100%',
                  background: getProbabilityColor(decisionState.probability),
                  borderRadius: 999,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span
              data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
              style={{
                fontSize: 11,
                color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {decisionState.probability.toFixed(1)}%
            </span>
          </div>

          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>成功/失败</span>
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
            <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
            <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ minWidth: 150, flex: 1 }}>
          <ModernSelect
            size="sm"
            value={String(activeTokenId || 0)}
            onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
            disabled={isUpdatingToken}
            options={[
              { value: '0', label: '默认令牌' },
              ...tokenOptions.map((token) => ({
                value: String(token.id),
                label: `${token.name}${token.isDefault ? '（默认）' : ''}`,
              })),
            ]}
            placeholder="默认令牌"
          />
        </div>
        <button
          onClick={onSaveToken}
          disabled={isUpdatingToken}
          className="btn btn-link btn-link-info"
        >
          {isUpdatingToken ? <span className="spinner spinner-sm" /> : '改令牌'}
        </button>
      </div>

      <button
        onClick={onDeleteChannel}
        className="btn btn-link btn-link-danger"
      >
        移除
      </button>
    </div>
  );
}

function AnimatedCollapseSection({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = useAnimatedVisibility(open, 220);
  if (!presence.shouldRender) return null;
  return (
    <div className={`anim-collapse ${presence.isVisible ? 'is-open' : ''}`.trim()}>
      <div className="anim-collapse-inner">
        {children}
      </div>
    </div>
  );
}

export default function TokenRoutes() {
  const navigate = useNavigate();
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [modelCandidates, setModelCandidates] = useState<RouteModelCandidatesByModelName>({});
  const [missingTokenModelsByName, setMissingTokenModelsByName] = useState<MissingTokenModelsByName>({});
  const [endpointTypesByModel, setEndpointTypesByModel] = useState<Record<string, string[]>>({});

  const [search, setSearch] = useState('');
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [activeSite, setActiveSite] = useState<string | null>(null);
  const [activeEndpointType, setActiveEndpointType] = useState<string | null>(null);
  const [activeGroupFilter, setActiveGroupFilter] = useState<GroupFilter>(null);
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [sortBy, setSortBy] = useState<RouteSortBy>('channelCount');
  const [sortDir, setSortDir] = useState<RouteSortDir>('desc');

  const [showManual, setShowManual] = useState(false);
  const filterPanelPresence = useAnimatedVisibility(!filterCollapsed, 220);
  const manualPanelPresence = useAnimatedVisibility(showManual, 220);
  const [form, setForm] = useState({ modelPattern: '', displayName: '', displayIcon: '' });
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const [channelDraftByRoute, setChannelDraftByRoute] = useState<Record<number, RouteChannelDraft>>({});
  const [channelTokenDraft, setChannelTokenDraft] = useState<Record<number, number>>({});
  const [updatingChannel, setUpdatingChannel] = useState<Record<number, boolean>>({});
  const [savingPriorityByRoute, setSavingPriorityByRoute] = useState<Record<number, boolean>>({});

  const [decisionByRoute, setDecisionByRoute] = useState<Record<number, RouteDecision | null>>({});
  const [loadingDecision, setLoadingDecision] = useState(false);
  const [decisionAutoSkipped, setDecisionAutoSkipped] = useState(false);
  const [visibleRouteCount, setVisibleRouteCount] = useState(ROUTE_RENDER_CHUNK);
  const [expandedSourceGroupMap, setExpandedSourceGroupMap] = useState<Record<string, boolean>>({});
  const [expandedRouteIds, setExpandedRouteIds] = useState<number[]>([]);
  const isMobile = useIsMobile(768);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const toast = useToast();

  const loadRouteDecisions = async (
    routeRows: RouteRow[],
    options?: { force?: boolean; refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) => {
    const rows = routeRows || [];
    const exactRoutes = rows.filter((route) => isExactModelPattern(route.modelPattern));
    const wildcardRouteIds = rows
      .filter((route) => !isExactModelPattern(route.modelPattern))
      .map((route) => route.id);

    const requestedModels = Array.from(new Set<string>(exactRoutes.map((route) => route.modelPattern)));

    const defaultState: Record<number, RouteDecision | null> = {};
    for (const route of rows) defaultState[route.id] = null;

    if (requestedModels.length === 0 && wildcardRouteIds.length === 0) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
      return;
    }

    const totalDecisionRequests = requestedModels.length + wildcardRouteIds.length;
    if (!options?.force && totalDecisionRequests > AUTO_ROUTE_DECISION_LIMIT) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(true);
      return;
    }

    setLoadingDecision(true);
    try {
      setDecisionAutoSkipped(false);
      const decisionRequestOptions = options?.refreshPricingCatalog
        ? {
          refreshPricingCatalog: true as const,
          ...(options?.persistSnapshots ? { persistSnapshots: true as const } : {}),
        }
        : options?.persistSnapshots
          ? { persistSnapshots: true as const }
        : undefined;
      const [exactRes, wildcardRes] = await Promise.all([
        requestedModels.length > 0
          ? api.getRouteDecisionsBatch(requestedModels, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
        wildcardRouteIds.length > 0
          ? api.getRouteWideDecisionsBatch(wildcardRouteIds, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
      ]);

      const decisionMap = (exactRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const wildcardDecisionMap = (wildcardRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const next = { ...defaultState };
      for (const route of exactRoutes) {
        next[route.id] = decisionMap[route.modelPattern] || null;
      }
      for (const routeId of wildcardRouteIds) {
        next[routeId] = wildcardDecisionMap[String(routeId)] || null;
      }

      setDecisionByRoute(next);
    } catch {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
    } finally {
      setLoadingDecision(false);
    }
  };

  const load = async () => {
    const [routeRows, candidateRows] = await Promise.all([
      api.getRoutes(),
      api.getModelTokenCandidates(),
    ]);

    const normalizedRoutes = normalizeRoutes(routeRows || []);
    setRoutes(normalizedRoutes);
    setModelCandidates((candidateRows?.models || {}) as RouteModelCandidatesByModelName);
    setMissingTokenModelsByName(
      normalizeMissingTokenModels((candidateRows?.modelsWithoutToken || {}) as MissingTokenModelsByName),
    );
    setEndpointTypesByModel(candidateRows?.endpointTypesByModel || {});
    const decisionPlaceholder: Record<number, RouteDecision | null> = {};
    for (const route of normalizedRoutes) {
      decisionPlaceholder[route.id] = route.decisionSnapshot || null;
    }
    setDecisionByRoute(decisionPlaceholder);
    setDecisionAutoSkipped(
      normalizedRoutes.some((route) => isExactModelPattern(route.modelPattern) && !route.decisionSnapshot),
    );
  };

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch {
        toast.error('加载路由配置失败');
      }
    })();
  }, []);

  const handleRebuild = async () => {
    try {
      setRebuilding(true);
      const res = await api.rebuildRoutes(true);
      if (res?.queued) {
        toast.info(res.message || '已开始重建路由，请稍后查看日志');
        await load();
        return;
      }
      const createdRoutes = res?.rebuild?.createdRoutes ?? 0;
      const createdChannels = res?.rebuild?.createdChannels ?? 0;
      toast.success(`自动重建完成（新增 ${createdRoutes} 条路由 / ${createdChannels} 个通道）`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '重建路由失败');
    } finally {
      setRebuilding(false);
    }
  };

  const handleRefreshRouteDecisions = async () => {
    try {
      await loadRouteDecisions(routes, { force: true, refreshPricingCatalog: true, persistSnapshots: true });
      toast.success('路由选择概率已刷新');
    } catch {
      toast.error('刷新路由选择概率失败');
    }
  };

  const exactRouteCount = useMemo(
    () => buildVisibleRouteList(routes, isExactModelPattern, matchesModelPattern)
      .filter((route) => isExactModelPattern(route.modelPattern)).length,
    [routes],
  );

  const modelPatternError = useMemo(
    () => getModelPatternError(form.modelPattern),
    [form.modelPattern],
  );

  const previewModelSamples = useMemo(() => {
    const names = new Set<string>();

    for (const modelName of Object.keys(modelCandidates || {})) {
      const normalized = modelName.trim();
      if (normalized) names.add(normalized);
    }

    for (const route of routes) {
      if (!isExactModelPattern(route.modelPattern)) continue;
      const normalized = route.modelPattern.trim();
      if (normalized) names.add(normalized);
    }

    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 800);
  }, [modelCandidates, routes]);

  const previewMatchedModels = useMemo(() => {
    const normalizedPattern = form.modelPattern.trim();
    if (!normalizedPattern || modelPatternError) return [] as string[];
    return previewModelSamples.filter((modelName) => matchesModelPattern(modelName, normalizedPattern));
  }, [form.modelPattern, modelPatternError, previewModelSamples]);

  const canSaveRoute = !saving
    && !!form.modelPattern.trim()
    && !modelPatternError;

  const resetRouteForm = () => {
    setForm({ modelPattern: '', displayName: '', displayIcon: '' });
    setEditingRouteId(null);
  };

  const handleAddRoute = async () => {
    if (!form.modelPattern.trim()) return;
    if (modelPatternError) {
      toast.error(modelPatternError);
      return;
    }

    const trimmedModelPattern = form.modelPattern.trim();
    const trimmedDisplayName = form.displayName.trim() ? form.displayName.trim() : undefined;
    const trimmedDisplayIcon = form.displayIcon.trim() ? form.displayIcon.trim() : undefined;
    setSaving(true);
    try {
      if (editingRouteId) {
        const currentRoute = routes.find((route) => route.id === editingRouteId) || null;
        const modelPatternChanged = !!currentRoute && currentRoute.modelPattern !== trimmedModelPattern;
        await api.updateRoute(editingRouteId, {
          modelPattern: trimmedModelPattern,
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
        });
        toast.success(modelPatternChanged ? tr('群组已更新并重新匹配通道') : tr('群组已更新'));
      } else {
        await api.addRoute({
          modelPattern: trimmedModelPattern,
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
        });
        toast.success(tr('群组已创建'));
      }
      setShowManual(false);
      resetRouteForm();
      await load();
    } catch (e: any) {
      toast.error(e.message || (editingRouteId ? tr('更新群组失败') : tr('创建群组失败')));
    } finally {
      setSaving(false);
    }
  };

  const handleEditRoute = (route: RouteRow) => {
    setEditingRouteId(route.id);
    setForm({
      modelPattern: route.modelPattern || '',
      displayName: route.displayName || '',
      displayIcon: normalizeRouteDisplayIconValue(route.displayIcon),
    });
    setShowManual(true);
  };

  const handleCancelEditRoute = () => {
    resetRouteForm();
    setShowManual(false);
  };

  const handleDeleteRoute = async (routeId: number) => {
    try {
      await api.deleteRoute(routeId);
      toast.success('路由已删除');
      await load();
    } catch (e: any) {
      toast.error(e.message || '删除路由失败');
    }
  };

  const handleToggleRouteEnabled = async (route: RouteRow) => {
    const newEnabled = !route.enabled;
    setRoutes((prev) =>
      prev.map((item) => (item.id === route.id ? { ...item, enabled: newEnabled } : item)),
    );
    try {
      await api.updateRoute(route.id, { enabled: newEnabled });
      toast.success(newEnabled ? '路由已启用' : '路由已禁用');
    } catch (e: any) {
      setRoutes((prev) =>
        prev.map((item) => (item.id === route.id ? { ...item, enabled: route.enabled } : item)),
      );
      toast.error(e.message || '切换路由状态失败');
    }
  };

  const routeBrandById = useMemo(() => {
    const next = new Map<number, BrandInfo | null>();
    for (const route of routes) {
      next.set(route.id, resolveRouteBrand(route));
    }
    return next;
  }, [routes]);

  const listVisibleRoutes = useMemo(
    () => buildVisibleRouteList(routes, isExactModelPattern, matchesModelPattern),
    [routes],
  );

  const brandList = useMemo(() => {
    const grouped = new Map<string, { count: number; brand: BrandInfo }>();
    let otherCount = 0;

    for (const route of listVisibleRoutes) {
      const brand = routeBrandById.get(route.id) || null;
      if (!brand) {
        otherCount++;
        continue;
      }

      const existing = grouped.get(brand.name);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(brand.name, { count: 1, brand });
      }
    }

    return {
      list: [...grouped.entries()].sort((a, b) => {
        if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
        return b[1].count - a[1].count;
      }),
      otherCount,
    };
  }, [listVisibleRoutes, routeBrandById]);

  const siteList = useMemo(() => {
    const grouped = new Map<string, { count: number; siteId: number }>();

    for (const route of listVisibleRoutes) {
      const seenSites = new Set<string>();
      for (const channel of route.channels || []) {
        const siteName = channel.site?.name;
        const siteId = channel.site?.id;
        if (!siteName || !siteId || seenSites.has(siteName)) continue;
        seenSites.add(siteName);

        const existing = grouped.get(siteName);
        if (existing) {
          existing.count++;
        } else {
          grouped.set(siteName, { count: 1, siteId });
        }
      }
    }

    return [...grouped.entries()].sort((a, b) => {
      if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
      return b[1].count - a[1].count;
    });
  }, [listVisibleRoutes]);

  const routeEndpointTypesByRouteId = useMemo(() => {
    const index: Record<number, Set<string>> = {};
    const entries = Object.entries(endpointTypesByModel || {});
    for (const route of routes) {
      const pattern = (route.modelPattern || '').trim();
      if (!pattern) {
        index[route.id] = new Set<string>();
        continue;
      }
      const endpointTypes = new Set<string>();
      for (const [modelName, rawTypes] of entries) {
        if (!matchesModelPattern(modelName, pattern)) continue;
        for (const rawType of Array.isArray(rawTypes) ? rawTypes : []) {
          const endpointType = String(rawType || '').trim();
          if (!endpointType) continue;
          endpointTypes.add(endpointType);
        }
      }
      if (endpointTypes.size === 0) {
        for (const channel of route.channels || []) {
          for (const endpointType of inferEndpointTypesFromPlatform(channel.site?.platform)) {
            endpointTypes.add(endpointType);
          }
        }
      }
      index[route.id] = endpointTypes;
    }
    return index;
  }, [routes, endpointTypesByModel]);

  const endpointTypeList = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const route of listVisibleRoutes) {
      const endpointTypes = routeEndpointTypesByRouteId[route.id] || new Set<string>();
      for (const endpointType of endpointTypes) {
        grouped.set(endpointType, (grouped.get(endpointType) || 0) + 1);
      }
    }
    return [...grouped.entries()].sort((a, b) => {
      if (a[1] === b[1]) return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
      return b[1] - a[1];
    });
  }, [listVisibleRoutes, routeEndpointTypesByRouteId]);

  const routeBrandIconCandidates = useMemo(() => {
    const byIcon = new Map<string, BrandInfo>();

    for (const route of routes) {
      const brand = resolveRouteBrand(route);
      if (brand) byIcon.set(brand.icon, brand);
    }

    for (const modelName of Object.keys(modelCandidates || {})) {
      const brand = getBrand(modelName);
      if (brand) byIcon.set(brand.icon, brand);
    }

    return Array.from(byIcon.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [routes, modelCandidates]);

  const routeIconSelectOptions = useMemo<RouteIconOption[]>(() => ([
    ...ROUTE_ICON_OPTIONS,
    ...routeBrandIconCandidates.map((brand) => ({
      value: toBrandIconValue(brand.icon),
      label: brand.name,
      description: `${brand.name} 品牌图标`,
      iconNode: <BrandGlyph brand={brand} size={14} fallbackText={brand.name} />,
    })),
  ]), [routeBrandIconCandidates]);

  const routeIconOptionValues = useMemo(
    () => new Set(routeIconSelectOptions.map((option) => option.value)),
    [routeIconSelectOptions],
  );

  const routeIconSelectValue = routeIconOptionValues.has(normalizeRouteDisplayIconValue(form.displayIcon))
    ? normalizeRouteDisplayIconValue(form.displayIcon)
    : '';

  const groupRouteList = useMemo(() => (
    listVisibleRoutes
      .filter((route) => !isExactModelPattern(route.modelPattern))
      .map((route) => ({
        id: route.id,
        title: resolveRouteTitle(route),
        icon: resolveRouteIcon(route),
        brand: routeBrandById.get(route.id) || null,
        modelPattern: route.modelPattern,
        channelCount: route.channels?.length ?? 0,
      }))
      .sort((a, b) => {
        if (a.channelCount === b.channelCount) return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return b.channelCount - a.channelCount;
      })
  ), [listVisibleRoutes, routeBrandById]);

  const activeGroupRoute = useMemo(() => {
    if (typeof activeGroupFilter !== 'number') return null;
    return listVisibleRoutes.find((route) => route.id === activeGroupFilter) || null;
  }, [activeGroupFilter, listVisibleRoutes]);

  const sortedRoutes = useMemo(() => (
    [...listVisibleRoutes].sort((a, b) => {
      if (sortBy === 'channelCount') {
        const countCmp = (a.channels?.length ?? 0) - (b.channels?.length ?? 0);
        if (countCmp !== 0) return sortDir === 'asc' ? countCmp : -countCmp;
      }

      const nameCmp = a.modelPattern.localeCompare(b.modelPattern, undefined, { sensitivity: 'base' });
      return sortDir === 'asc' ? nameCmp : -nameCmp;
    })
  ), [listVisibleRoutes, sortBy, sortDir]);

  const filteredRoutes = useMemo(() => {
    let list = sortedRoutes;

    if (activeGroupFilter === '__all__') {
      list = list.filter((route) => !isExactModelPattern(route.modelPattern));
    } else if (typeof activeGroupFilter === 'number') {
      list = list.filter((route) => route.id === activeGroupFilter);
    }

    if (activeBrand) {
      if (activeBrand === '__other__') {
        list = list.filter((route) => !(routeBrandById.get(route.id) || null));
      } else {
        list = list.filter((route) => (routeBrandById.get(route.id)?.name || '') === activeBrand);
      }
    }

    if (activeSite) {
      list = list.filter((route) =>
        route.channels?.some((channel) => channel.site?.name === activeSite)
      );
    }

    if (activeEndpointType) {
      list = list.filter((route) =>
        (routeEndpointTypesByRouteId[route.id] || new Set<string>()).has(activeEndpointType)
      );
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((route) => route.modelPattern.toLowerCase().includes(q));
    }

    return list;
  }, [
    sortedRoutes,
    activeGroupFilter,
    activeBrand,
    activeSite,
    activeEndpointType,
    search,
    routeBrandById,
    routeEndpointTypesByRouteId,
  ]);

  useEffect(() => {
    setVisibleRouteCount(getInitialVisibleCount(filteredRoutes.length, ROUTE_RENDER_CHUNK));
  }, [filteredRoutes.length]);

  const handleLoadMoreRoutes = () => {
    setVisibleRouteCount((current) => getNextVisibleCount(current, filteredRoutes.length, ROUTE_RENDER_CHUNK));
  };

  const visibleRoutes = useMemo(
    () => filteredRoutes.slice(0, visibleRouteCount),
    [filteredRoutes, visibleRouteCount],
  );

  const routeModelCandidateIndex = useMemo(
    () => buildRouteModelCandidatesIndex(routes, modelCandidates, matchesModelPattern),
    [routes, modelCandidates],
  );

  const routeMissingTokenIndex = useMemo(
    () => buildRouteMissingTokenIndex(routes, missingTokenModelsByName, matchesModelPattern),
    [routes, missingTokenModelsByName],
  );

  const getRouteCandidateView = (routeId: number): RouteCandidateView => {
    return routeModelCandidateIndex[routeId] || EMPTY_ROUTE_CANDIDATE_VIEW;
  };

  const handleCreateTokenForMissingAccount = (accountId: number, modelName: string) => {
    if (!Number.isFinite(accountId) || accountId <= 0) return;
    const params = new URLSearchParams();
    params.set('create', '1');
    params.set('accountId', String(accountId));
    params.set('model', modelName);
    params.set('from', 'routes');
    navigate(`/tokens?${params.toString()}`);
  };

  const handleRouteAccountChange = (route: RouteRow, accountId: number) => {
    const tokenOptions = getRouteCandidateView(route.id).tokenOptionsByAccountId[accountId] || [];
    const defaultTokenOption = tokenOptions.find((token) => token.isDefault) || tokenOptions[0] || null;
    setChannelDraftByRoute((prev) => ({
      ...prev,
      [route.id]: {
        accountId,
        tokenId: defaultTokenOption?.id || 0,
        sourceModel: defaultTokenOption?.sourceModel || '',
      },
    }));
  };

  const handleRouteTokenChange = (routeId: number, tokenId: number, sourceModel: string) => {
    setChannelDraftByRoute((prev) => ({
      ...prev,
      [routeId]: {
        accountId: prev[routeId]?.accountId || 0,
        tokenId,
        sourceModel: sourceModel || '',
      },
    }));
  };

  const handleAddChannel = async (route: RouteRow) => {
    const draft = channelDraftByRoute[route.id];
    if (!draft?.accountId) return;

    const tokenOptions = getRouteCandidateView(route.id).tokenOptionsByAccountId[draft.accountId] || [];
    if (draft.tokenId && tokenOptions.length > 0 && !tokenOptions.some((token) => token.id === draft.tokenId)) {
      toast.error('该令牌不支持当前模型');
      return;
    }

    try {
      await api.addChannel(route.id, {
        accountId: draft.accountId,
        tokenId: draft.tokenId || undefined,
        sourceModel: draft.sourceModel || undefined,
      });
      toast.success('通道已添加');
      setChannelDraftByRoute((prev) => ({
        ...prev,
        [route.id]: {
          accountId: 0,
          tokenId: 0,
          sourceModel: '',
        },
      }));
      await load();
    } catch (e: any) {
      toast.error(e.message || '添加通道失败');
    }
  };

  const handleDeleteChannel = async (channelId: number) => {
    try {
      await api.deleteChannel(channelId);
      toast.success('通道已移除');
      await load();
    } catch (e: any) {
      toast.error(e.message || '移除通道失败');
    }
  };

  const handleChannelTokenSave = async (route: RouteRow, channelId: number, accountId: number) => {
    const tokenId = channelTokenDraft[channelId];
    const tokenOptions = getRouteCandidateView(route.id).tokenOptionsByAccountId[accountId] || [];

    if (tokenId && tokenOptions.length > 0 && !tokenOptions.some((token) => token.id === tokenId)) {
      toast.error('该令牌不支持当前模型');
      return;
    }

    setUpdatingChannel((prev) => ({ ...prev, [channelId]: true }));
    try {
      await api.updateChannel(channelId, { tokenId: tokenId || null });
      toast.success('通道令牌已更新');
      await load();
    } catch (e: any) {
      toast.error(e.message || '更新令牌失败');
    } finally {
      setUpdatingChannel((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleChannelDragEnd = async (route: RouteRow, event: DragEndEvent) => {
    if (savingPriorityByRoute[route.id]) return;

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const channels = route.channels || [];
    const oldIndex = channels.findIndex((channel) => channel.id === Number(active.id));
    const newIndex = channels.findIndex((channel) => channel.id === Number(over.id));

    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

    const previousChannels = [...channels];
    const reordered = arrayMove(channels, oldIndex, newIndex).map((channel: RouteChannel, index: number) => ({
      ...channel,
      priority: index,
    }));

    setRoutes((prev) =>
      prev.map((item) => (item.id === route.id ? { ...item, channels: reordered } : item)),
    );
    setSavingPriorityByRoute((prev) => ({ ...prev, [route.id]: true }));

    try {
      await api.batchUpdateChannels(
        reordered.map((channel: RouteChannel) => ({
          id: channel.id,
          priority: channel.priority,
        })),
      );

      if (isExactModelPattern(route.modelPattern)) {
        try {
          const res = await api.getRouteDecision(route.modelPattern);
          setDecisionByRoute((prev) => ({
            ...prev,
            [route.id]: (res?.decision || null) as RouteDecision | null,
          }));
        } catch {
          // ignore route decision refresh failures after reorder
        }
      }
    } catch (e: any) {
      setRoutes((prev) =>
        prev.map((item) => (item.id === route.id ? { ...item, channels: previousChannels } : item)),
      );
      toast.error(e.message || '保存通道优先级失败，已回滚');
    } finally {
      setSavingPriorityByRoute((prev) => ({ ...prev, [route.id]: false }));
    }
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', gap: 24, minHeight: 400 }}>
      {filterPanelPresence.shouldRender && (
        <div className={`filter-panel filter-collapsible ${filterPanelPresence.isVisible ? '' : 'is-closing'}`.trim()}>
          <div className="filter-panel-section">
            <div className="filter-panel-title">
              品牌
              {activeBrand && <button onClick={() => setActiveBrand(null)}>重置</button>}
            </div>

            <div className={`filter-item ${!activeBrand ? 'active' : ''}`} onClick={() => setActiveBrand(null)}>
              <span
                className="filter-item-icon"
                style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
              >
                ✦
              </span>
              全部品牌
              <span className="filter-item-count">{routes.length}</span>
            </div>

            {brandList.list.map(([brandName, { count, brand }]) => (
              <div
                key={brandName}
                className={`filter-item ${activeBrand === brandName ? 'active' : ''}`}
                onClick={() => setActiveBrand(activeBrand === brandName ? null : brandName)}
              >
                <span className="filter-item-icon" style={{ background: 'var(--color-bg)', borderRadius: 4, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <BrandGlyph brand={brand} size={14} fallbackText={brandName} />
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brandName}</span>
                <span className="filter-item-count">{count}</span>
              </div>
            ))}

            {brandList.otherCount > 0 && (
              <div
                className={`filter-item ${activeBrand === '__other__' ? 'active' : ''}`}
                onClick={() => setActiveBrand(activeBrand === '__other__' ? null : '__other__')}
              >
                <span
                  className="filter-item-icon"
                  style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)', fontSize: 10 }}
                >
                  ?
                </span>
                其他
                <span className="filter-item-count">{brandList.otherCount}</span>
              </div>
            )}
          </div>

          <div className="filter-panel-section">
            <div className="filter-panel-title">
              {tr('群组')}
              {activeGroupFilter !== null && <button onClick={() => setActiveGroupFilter(null)}>重置</button>}
            </div>

            <div
              className={`filter-item ${activeGroupFilter === '__all__' ? 'active' : ''}`}
              onClick={() => setActiveGroupFilter(activeGroupFilter === '__all__' ? null : '__all__')}
            >
              <span
                className="filter-item-icon"
                style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
              >
                ◎
              </span>
              {tr('全部群组')}
              <span className="filter-item-count">{groupRouteList.length}</span>
            </div>

            {groupRouteList.map((groupRoute) => (
              <div
                key={groupRoute.id}
                className={`filter-item ${activeGroupFilter === groupRoute.id ? 'active' : ''}`}
                onClick={() => setActiveGroupFilter(activeGroupFilter === groupRoute.id ? null : groupRoute.id)}
              >
                <span
                  className="filter-item-icon"
                  style={{ background: 'var(--color-bg)', borderRadius: 4, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {groupRoute.icon.kind === 'brand' ? (
                    <BrandGlyph icon={groupRoute.icon.value} alt={groupRoute.title} size={14} fallbackText={groupRoute.title} />
                  ) : groupRoute.icon.kind === 'text' ? (
                    <span style={{ fontSize: 12, lineHeight: 1 }}>{groupRoute.icon.value}</span>
                  ) : groupRoute.brand ? (
                    <BrandGlyph brand={groupRoute.brand} alt={groupRoute.title} size={14} fallbackText={groupRoute.title} />
                  ) : (
                    <InlineBrandIcon model={groupRoute.modelPattern} size={14} />
                  )}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{groupRoute.title}</span>
                <span className="filter-item-count">{groupRoute.channelCount}</span>
              </div>
            ))}
          </div>

          {siteList.length > 0 && (
            <div className="filter-panel-section">
              <div className="filter-panel-title">
                站点
                {activeSite && <button onClick={() => setActiveSite(null)}>重置</button>}
              </div>

              <div className={`filter-item ${!activeSite ? 'active' : ''}`} onClick={() => setActiveSite(null)}>
                <span
                  className="filter-item-icon"
                  style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
                >
                  ⚡
                </span>
                全部站点
                <span className="filter-item-count">{routes.length}</span>
              </div>

              {siteList.map(([siteName, { count }]) => (
                <div
                  key={siteName}
                  className={`filter-item ${activeSite === siteName ? 'active' : ''}`}
                  onClick={() => setActiveSite(activeSite === siteName ? null : siteName)}
                >
                  <span
                    className="filter-item-icon"
                    style={{ background: hashColor(siteName), color: 'white', fontSize: 9, borderRadius: 4 }}
                  >
                    {siteAvatarLetters(siteName)}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{siteName}</span>
                  <span className="filter-item-count">{count}</span>
                </div>
              ))}
            </div>
          )}

          <div className="filter-panel-section">
            <div className="filter-panel-title">
              接口能力
              {activeEndpointType && <button onClick={() => setActiveEndpointType(null)}>重置</button>}
            </div>

            <div className={`filter-item ${!activeEndpointType ? 'active' : ''}`} onClick={() => setActiveEndpointType(null)}>
              <span
                className="filter-item-icon"
                style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
              >
                ⚙
              </span>
              全部能力
              <span className="filter-item-count">{routes.length}</span>
            </div>

            {endpointTypeList.map(([endpointType, count]) => (
              <div
                key={endpointType}
                className={`filter-item ${activeEndpointType === endpointType ? 'active' : ''}`}
                onClick={() => setActiveEndpointType(activeEndpointType === endpointType ? null : endpointType)}
              >
                <span
                  className="filter-item-icon"
                  style={{
                    background: 'var(--color-bg)',
                    color: 'var(--color-text-muted)',
                    fontSize: 10,
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  {(() => {
                    const iconModel = resolveEndpointTypeIconModel(endpointType);
                    if (!iconModel) return <span style={{ fontSize: 10 }}>⚙</span>;
                    return <InlineBrandIcon model={iconModel} size={14} />;
                  })()}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{endpointType}</span>
                <span className="filter-item-count">{count}</span>
              </div>
            ))}

            {endpointTypeList.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '4px 10px 0' }}>
                暂无接口能力数据
              </div>
            )}
          </div>

          <button
            className="btn btn-ghost"
            style={{
              width: '100%',
              fontSize: 12,
              padding: '6px 10px',
              marginTop: 8,
              justifyContent: 'center',
              border: '1px solid var(--color-border)',
            }}
            onClick={() => setFilterCollapsed(true)}
          >
            {tr('收起')}
          </button>
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activeGroupFilter === '__all__'
                ? tr('群组路由')
                : (activeGroupRoute
                  ? `${resolveRouteTitle(activeGroupRoute)} ${tr('路由')}`
                  : (activeBrand && activeBrand !== '__other__' ? `${activeBrand} ${tr('路由')}` : tr('模型路由')))}
              <span className="badge badge-info" style={{ fontSize: 12, fontWeight: 500 }}>
                {tr('共')} {filteredRoutes.length} {tr('条路由')}
              </span>
            </h2>
            {(activeBrand || activeGroupFilter !== null) && (
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
                {activeGroupFilter === '__all__'
                  ? tr('查看群组路由')
                  : (activeGroupRoute
                    ? `${tr('查看')} ${resolveRouteTitle(activeGroupRoute)} ${tr('群组路由')}`
                    : (activeBrand === '__other__' ? tr('查看未归类品牌路由') : `${tr('查看')} ${activeBrand} ${tr('品牌路由')}`))}
              </p>
            )}
          </div>

          <div className="page-actions" style={{ flexWrap: 'wrap' }}>
            {filterCollapsed && (
              <button
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
                onClick={() => setFilterCollapsed(false)}
              >
                {tr('筛选')}
              </button>
            )}

            <button
              onClick={handleRefreshRouteDecisions}
              disabled={loadingDecision}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            >
              {loadingDecision ? (
                <>
                  <span className="spinner spinner-sm" /> 刷新中...
                </>
              ) : (
                tr('刷新选中概率')
              )}
            </button>

            <button
              onClick={handleRebuild}
              disabled={rebuilding}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            >
              {rebuilding ? (
                <>
                  <span className="spinner spinner-sm" /> 重建中...
                </>
              ) : (
                tr('自动重建')
              )}
            </button>

            <button
              onClick={() => {
                if (showManual) {
                  setShowManual(false);
                  resetRouteForm();
                  return;
                }
                setShowManual(true);
                resetRouteForm();
              }}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            >
              {editingRouteId
                ? tr('取消编辑')
                : (showManual ? tr('收起群组创建') : tr('新建群组'))}
            </button>
          </div>
        </div>

        <div className="toolbar">
          <div className="toolbar-search" style={{ minWidth: 280 }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('搜索模型路由...')}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 128 }}>
              <ModernSelect
                size="sm"
                value={sortBy}
                onChange={(nextValue) => {
                  const nextSortBy = nextValue as RouteSortBy;
                  setSortBy(nextSortBy);
                  setSortDir(nextSortBy === 'modelPattern' ? 'asc' : 'desc');
                }}
                options={[
                  { value: 'modelPattern', label: tr('模型名称') },
                  { value: 'channelCount', label: tr('通道数量') },
                ]}
                placeholder={tr('排序字段')}
              />
            </div>
            <button
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', padding: '8px 12px', fontSize: 12 }}
              onClick={() => setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              data-tooltip={tr('切换排序方向')}
              aria-label={tr('切换排序方向')}
            >
              {sortDir === 'asc' ? tr('升序 ↑') : tr('降序 ↓')}
            </button>
          </div>
        </div>

        <div className="info-tip" style={{ marginBottom: 12 }}>
            {tr('系统会根据模型可用性自动生成路由。精确模型路由会自动过滤只支持该模型的账号和令牌。优先级 P0 最高，数字越大优先级越低。选中概率表示请求到达时该通道被选中的概率。成本来源优先级为：实测成本 → 账号配置成本 → 目录参考价 → 默认回退单价。')}
            {decisionAutoSkipped ? ` ${tr('当前精确路由')} ${exactRouteCount} ${tr('条，为避免首屏卡顿，默认不自动计算概率，点击“加载选择解释”后按需获取。')}` : ''}
          </div>

          {manualPanelPresence.shouldRender && (
            <div className={`card panel-presence ${manualPanelPresence.isVisible ? '' : 'is-closing'}`.trim()} style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                {editingRouteId
                  ? tr('编辑群组路由名称、图标和模型匹配规则；若修改正则，将按当前可用模型重新匹配自动通道。')
                  : tr('用于创建群组路由（聚合多个上游模型为一个下游模型名，即模型重定向）；自动路由仍会保持开启。')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10 }}>
                  <input
                    placeholder={tr('群组显示名（可选，例如 claude-opus-4-6）')}
                    value={form.displayName}
                    onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 13,
                      outline: 'none',
                      background: 'var(--color-bg)',
                      color: 'var(--color-text-primary)',
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <ModernSelect
                      value={routeIconSelectValue}
                      onChange={(nextValue) => setForm((f) => ({ ...f, displayIcon: nextValue }))}
                      options={routeIconSelectOptions}
                      placeholder={tr('图标（可选，选择品牌图标）')}
                      emptyLabel={tr('暂无可选品牌图标')}
                    />
                  </div>
                </div>
                <input
                  placeholder={tr('模型匹配（如 gpt-4o、claude-*、re:^claude-.*$）')}
                  value={form.modelPattern}
                  onChange={(e) => setForm((f) => ({ ...f, modelPattern: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    border: `1px solid ${modelPatternError ? 'var(--color-danger)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 13,
                    outline: 'none',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text-primary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                />
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: -4 }}>
                  {tr('正则请使用 re: 前缀；例如 re:^claude-(opus|sonnet)-4-6$')}
                </div>
                {modelPatternError && (
                  <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: -4 }}>
                    {modelPatternError}
                  </div>
                )}
                {form.modelPattern.trim() && !modelPatternError && (
                  <div
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '10px 12px',
                      background: 'var(--color-bg)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                      {tr('规则预览：命中样本')} {previewMatchedModels.length} / {previewModelSamples.length}
                    </div>

                    {previewModelSamples.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {tr('当前暂无可预览模型，请先同步模型。')}
                      </div>
                    ) : previewMatchedModels.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {tr('当前规则未命中任何样本模型。')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {previewMatchedModels.slice(0, 12).map((modelName) => (
                          <code
                            key={modelName}
                            style={{
                              fontSize: 11,
                              padding: '2px 6px',
                              borderRadius: 6,
                              border: '1px solid var(--color-border)',
                              background: 'var(--color-bg-card)',
                            }}
                          >
                            {modelName}
                          </code>
                        ))}
                      </div>
                    )}

                    {previewMatchedModels.length > 12 && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                        {tr('仅展示前 12 个命中样本。')}
                      </div>
                    )}

                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={handleAddRoute}
                    disabled={!canSaveRoute}
                    className="btn btn-success"
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {saving ? (
                      <>
                        <span
                          className="spinner spinner-sm"
                          style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }}
                        />{' '}
                        保存中...
                      </>
                    ) : (
                      tr(editingRouteId ? '保存群组' : '创建群组')
                    )}
                  </button>
                  {editingRouteId ? (
                    <button
                      onClick={handleCancelEditRoute}
                      className="btn btn-ghost"
                      style={{ alignSelf: 'flex-start', border: '1px solid var(--color-border)' }}
                    >
                      {tr('取消编辑')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          <div
            className={isMobile ? 'mobile-card-list' : ''}
            style={isMobile ? undefined : { display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {visibleRoutes.map((route, i) => {
              const candidateView = getRouteCandidateView(route.id);
              const routeCandidates = candidateView.routeCandidates;
              const accountOptions = candidateView.accountOptions;
              const selectedAccountId = channelDraftByRoute[route.id]?.accountId || 0;
              const selectedDraftTokenValue = (() => {
                const draft = channelDraftByRoute[route.id];
                if (!draft || !draft.tokenId) return '0';
                return `${draft.tokenId}::${draft.sourceModel || ''}`;
              })();
              const draftTokenOptions = selectedAccountId
                ? (candidateView.tokenOptionsByAccountId[selectedAccountId] || [])
                : [];
              const candidateMode = routeCandidates.length > 0;
              const missingTokenHints = routeMissingTokenIndex[route.id] || [];
              const missingTokenSiteItems = (() => {
                const siteMap = new Map<string, MissingTokenRouteSiteActionItem>();
                for (const hint of missingTokenHints) {
                  for (const account of hint.accounts) {
                    if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
                    const siteName = (account.siteName || '').trim() || `site-${account.siteId || 'unknown'}`;
                    const key = `${account.siteId || 0}::${siteName.toLowerCase()}`;
                    const accountLabel = account.username || `account-${account.accountId}`;
                    const existing = siteMap.get(key);
                    if (!existing) {
                      siteMap.set(key, {
                        key,
                        siteName,
                        accountId: account.accountId,
                        accountLabel,
                      });
                      continue;
                    }
                    if (account.accountId < existing.accountId) {
                      existing.accountId = account.accountId;
                      existing.accountLabel = accountLabel;
                    }
                  }
                }
                return Array.from(siteMap.values()).sort((a, b) => (
                  a.siteName.localeCompare(b.siteName, undefined, { sensitivity: 'base' })
                ));
              })();
              const routeDecision = decisionByRoute[route.id] || null;
              const exactRoute = isExactModelPattern(route.modelPattern);
              const decisionMap = new Map<number, RouteDecisionCandidate>(
                (routeDecision?.candidates || []).map((candidate) => [candidate.channelId, candidate]),
              );
              const channelGroups = (() => {
                const groups = new Map<string, RouteChannel[]>();
                for (const channel of route.channels || []) {
                  const key = (channel.sourceModel || '').trim() || '__ungrouped__';
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(channel);
                }

                return Array.from(groups.entries())
                  .sort((a, b) => {
                    if (a[0] === '__ungrouped__') return 1;
                    if (b[0] === '__ungrouped__') return -1;
                    return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
                  })
                  .map(([sourceModel, channels]) => ({
                    sourceModel: sourceModel === '__ungrouped__' ? '' : sourceModel,
                    channels,
                  }));
              })();
              const routeIcon = resolveRouteIcon(route);
              const routeBrand = routeBrandById.get(route.id) || null;

              const routeCard = (
                <div
                  key={route.id}
                  className={`card animate-slide-up stagger-${Math.min(i + 1, 5)}`}
                  style={{ padding: 16 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 12,
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <code
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          background: 'var(--color-bg)',
                          padding: '4px 10px',
                          borderRadius: 6,
                          color: 'var(--color-text-primary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        {routeIcon.kind === 'brand' ? (
                          <BrandGlyph icon={routeIcon.value} alt={resolveRouteTitle(route)} size={20} fallbackText={resolveRouteTitle(route)} />
                        ) : routeIcon.kind === 'text' ? (
                          <span
                            style={{
                              width: 20,
                              height: 20,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 8,
                              background: 'var(--color-bg-card)',
                              fontSize: 14,
                              lineHeight: 1,
                            }}
                          >
                            {routeIcon.value}
                          </span>
                        ) : routeBrand ? (
                          <BrandGlyph brand={routeBrand} alt={resolveRouteTitle(route)} size={20} fallbackText={resolveRouteTitle(route)} />
                        ) : (
                          <InlineBrandIcon model={route.modelPattern} size={20} />
                        )}
                        {resolveRouteTitle(route)}
                      </code>
                      {route.displayName && route.displayName.trim().length > 0 && route.displayName.trim() !== route.modelPattern ? (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>
                          {route.modelPattern}
                        </span>
                      ) : null}
                      <button
                        className={`badge route-enable-toggle ${route.enabled ? 'is-enabled' : 'is-disabled'}`}
                        style={{ fontSize: 11, cursor: 'pointer', border: 'none' }}
                        onClick={(e) => { e.stopPropagation(); handleToggleRouteEnabled(route); }}
                        data-tooltip={route.enabled ? '点击禁用此路由' : '点击启用此路由'}
                        aria-label={route.enabled ? '点击禁用此路由' : '点击启用此路由'}
                      >
                        {route.enabled ? tr('启用') : tr('禁用')}
                      </button>
                      <span className="badge badge-info" style={{ fontSize: 10 }}>
                        {route.channels?.length || 0} {tr('通道')}
                      </span>
                      {candidateMode && (
                        <span
                          className="badge badge-info"
                          style={{ fontSize: 10 }}
                          data-tooltip="添加通道时，仅展示可覆盖当前模型模式的账号与令牌，自动过滤不支持该模型的令牌。"
                        >
                          {tr('按模型过滤')}
                        </span>
                      )}
                      {missingTokenSiteItems.length > 0 && (
                        <span className="badge badge-warning" style={{ fontSize: 10 }}>
                          待注册站点 {missingTokenSiteItems.length}
                        </span>
                      )}
                      {channelGroups.length > 1 && (
                        <span className="badge badge-info" style={{ fontSize: 10 }}>
                          {channelGroups.length} 来源分组
                        </span>
                      )}
                      {savingPriorityByRoute[route.id] ? (
                        <span className="badge badge-warning" style={{ fontSize: 10 }}>
                          {tr('排序保存中')}
                        </span>
                      ) : null}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {!exactRoute ? (
                        <button
                          onClick={() => handleEditRoute(route)}
                          className="btn btn-link"
                        >
                          {tr('编辑群组')}
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleDeleteRoute(route.id)}
                        className="btn btn-link btn-link-danger"
                      >
                        {tr('删除路由')}
                      </button>
                    </div>
                  </div>

                  {!exactRoute && (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                      {tr('通配符路由按请求实时决策；概率解释在当前路由内统一估算。')}
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 10 }}>
                    <ModernSelect
                      size="sm"
                      value={String(selectedAccountId || 0)}
                      onChange={(nextValue) => handleRouteAccountChange(route, Number.parseInt(nextValue, 10) || 0)}
                      options={[
                        { value: '0', label: tr('选择账号') },
                        ...accountOptions.map((option) => ({
                          value: String(option.id),
                          label: option.label,
                        })),
                      ]}
                      placeholder={tr('选择账号')}
                    />

                    <ModernSelect
                      size="sm"
                      value={selectedDraftTokenValue}
                      onChange={(nextValue) => {
                        if (nextValue === '0') {
                          handleRouteTokenChange(route.id, 0, '');
                          return;
                        }
                        const [tokenRaw, ...sourceParts] = nextValue.split('::');
                        const nextTokenId = Number.parseInt(tokenRaw, 10) || 0;
                        const sourceModel = sourceParts.join('::');
                        handleRouteTokenChange(route.id, nextTokenId, sourceModel);
                      }}
                      disabled={!selectedAccountId}
                      options={[
                        { value: '0', label: '选择令牌（可选）' },
                        ...draftTokenOptions.map((token) => ({
                          value: `${token.id}::${token.sourceModel || ''}`,
                          label: `${token.name}${token.isDefault ? '（默认）' : ''}${token.sourceModel ? ` [${token.sourceModel}]` : ''}`,
                        })),
                      ]}
                      placeholder="选择令牌（可选）"
                    />

                    <button
                      onClick={() => handleAddChannel(route)}
                      className="btn btn-ghost"
                      style={{
                        fontSize: 12,
                        padding: '6px 10px',
                        color: 'var(--color-primary)',
                        border: '1px solid var(--color-border)',
                      }}
                    >
                      + 添加通道
                    </button>
                  </div>

                  {accountOptions.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--color-warning)', marginBottom: 8 }}>
                      当前没有任何账号/令牌可用此模型，请先同步令牌与模型。
                    </div>
                  )}

                  {missingTokenSiteItems.length > 0 && (
                    <div
                      style={{
                        marginBottom: 8,
                        padding: '8px 10px',
                        border: '1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'color-mix(in srgb, var(--color-warning) 10%, var(--color-bg))',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        以下站点已提供该模型，但你未注册对应站点令牌；点击站点标签可跳转创建对应站点令牌：
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        {missingTokenSiteItems.map((item) => (
                          <button
                            key={`missing-create-${route.id}-${item.key}`}
                            type="button"
                            onClick={() => handleCreateTokenForMissingAccount(item.accountId, route.modelPattern)}
                            className="badge badge-info missing-token-site-tag"
                            data-tooltip={`点击跳转到令牌创建（预选 ${item.siteName}/${item.accountLabel}）`}
                            aria-label={`点击跳转到令牌创建（预选 ${item.siteName}/${item.accountLabel}）`}
                            style={{
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            {item.siteName}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {route.channels?.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event: DragEndEvent) => {
                          void handleChannelDragEnd(route, event);
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {channelGroups.map((group) => (
                            <div key={`${route.id}-${group.sourceModel || '__ungrouped__'}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {(() => {
                                const groupKey = buildSourceGroupKey(route.id, group.sourceModel || '');
                                const supportsCollapse = !exactRoute && !!group.sourceModel;
                                const isGroupExpanded = supportsCollapse ? !!expandedSourceGroupMap[groupKey] : true;

                                return (
                                  <>
                                    {group.sourceModel ? (
                                      supportsCollapse ? (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setExpandedSourceGroupMap((prev) => ({
                                              ...prev,
                                              [groupKey]: !prev[groupKey],
                                            }));
                                          }}
                                          aria-expanded={isGroupExpanded}
                                          className="btn btn-ghost"
                                          style={{
                                            fontSize: 12,
                                            color: 'var(--color-text-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            padding: '4px 6px',
                                            border: '1px dashed var(--color-border)',
                                            borderRadius: 'var(--radius-sm)',
                                            background: 'transparent',
                                          }}
                                        >
                                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                            <span>来源模型</span>
                                            <code
                                              style={{
                                                fontSize: 11,
                                                border: '1px solid var(--color-border)',
                                                borderRadius: 6,
                                                padding: '2px 6px',
                                                background: 'var(--color-bg)',
                                              }}
                                            >
                                              {group.sourceModel}
                                            </code>
                                            <span style={{ color: 'var(--color-text-muted)' }}>{group.channels.length} 通道</span>
                                          </span>
                                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-text-muted)' }}>
                                            {isGroupExpanded ? '收起' : '展开'}
                                            <svg
                                              width="12"
                                              height="12"
                                              viewBox="0 0 20 20"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="2"
                                              style={{
                                                transform: isGroupExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                                transition: 'transform 0.2s ease',
                                              }}
                                              aria-hidden
                                            >
                                              <path d="m5 7 5 6 5-6" />
                                            </svg>
                                          </span>
                                        </button>
                                      ) : (
                                        <div
                                          style={{
                                            fontSize: 12,
                                            color: 'var(--color-text-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            paddingLeft: 2,
                                          }}
                                        >
                                          <span>来源模型</span>
                                          <code
                                            style={{
                                              fontSize: 11,
                                              border: '1px solid var(--color-border)',
                                              borderRadius: 6,
                                              padding: '2px 6px',
                                              background: 'var(--color-bg)',
                                            }}
                                          >
                                            {group.sourceModel}
                                          </code>
                                          <span style={{ color: 'var(--color-text-muted)' }}>{group.channels.length} 通道</span>
                                        </div>
                                      )
                                    ) : null}

                                    <AnimatedCollapseSection open={isGroupExpanded}>
                                        <SortableContext
                                          items={group.channels.map((channel) => channel.id)}
                                          strategy={verticalListSortingStrategy}
                                        >
                                          {group.channels.map((channel) => {
                                            const tokenOptions = candidateView.tokenOptionsByAccountId[channel.accountId] || [];
                                            const activeTokenId = channelTokenDraft[channel.id] ?? channel.tokenId ?? 0;

                                            return (
                                              <SortableChannelRow
                                                key={channel.id}
                                                channel={channel}
                                                decisionCandidate={decisionMap.get(channel.id)}
                                                isExactRoute={exactRoute}
                                                loadingDecision={loadingDecision}
                                                isSavingPriority={!!savingPriorityByRoute[route.id]}
                                                tokenOptions={tokenOptions}
                                                activeTokenId={activeTokenId}
                                                isUpdatingToken={!!updatingChannel[channel.id]}
                                                onTokenDraftChange={(channelId, tokenId) =>
                                                  setChannelTokenDraft((prev) => ({ ...prev, [channelId]: tokenId }))
                                                }
                                                onSaveToken={() => handleChannelTokenSave(route, channel.id, channel.accountId)}
                                                onDeleteChannel={() => handleDeleteChannel(channel.id)}
                                              />
                                            );
                                          })}
                                        </SortableContext>
                                    </AnimatedCollapseSection>
                                    {!isGroupExpanded ? (
                                      <div
                                        style={{
                                          fontSize: 11,
                                          color: 'var(--color-text-muted)',
                                          paddingLeft: 6,
                                        }}
                                      >
                                        已收起，点击展开查看通道
                                      </div>
                                    ) : null}
                                  </>
                                );
                              })()}
                            </div>
                          ))}
                        </div>
                      </DndContext>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--color-text-muted)', paddingLeft: 4 }}>暂无通道</div>
                  )}
                </div>
              );

              const isExpanded = expandedRouteIds.includes(route.id);

              return isMobile ? (
                <MobileCard
                  key={route.id}
                  title={resolveRouteTitle(route)}
                  actions={(
                    <span className={`badge ${route.enabled ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 10 }}>
                      {route.enabled ? tr('启用') : tr('禁用')}
                    </span>
                  )}
                >
                  <MobileField label="模型" value={route.modelPattern} />
                  <MobileField label="通道" value={route.channels?.length || 0} />
                  <MobileField label="状态" value={route.enabled ? tr('启用') : tr('禁用')} />
                  {isExpanded ? (
                    <div className="mobile-card-extra">
                      {routeCard}
                    </div>
                  ) : null}
                  <div className="mobile-card-actions">
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => setExpandedRouteIds((prev) => (
                        prev.includes(route.id)
                          ? prev.filter((id) => id !== route.id)
                          : [...prev, route.id]
                      ))}
                    >
                      {isExpanded ? '收起' : '详情'}
                    </button>
                  </div>
                </MobileCard>
              ) : (
                routeCard
              );
            })}

            {filteredRoutes.length > 0 && visibleRouteCount < filteredRoutes.length && (
              <div style={{ textAlign: 'center', padding: '8px 0 14px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  {tr('当前已加载路由')} {visibleRouteCount} / {filteredRoutes.length}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', padding: '7px 14px', fontSize: 12 }}
                  onClick={handleLoadMoreRoutes}
                >
                  {tr('加载更多路由')}
                </button>
              </div>
            )}

            {filteredRoutes.length === 0 && (
              <div className="card">
                <div className="empty-state">
                  <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1}
                      d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                    />
                  </svg>
                  <div className="empty-state-title">{routes.length === 0 ? '暂无路由' : '没有匹配的路由'}</div>
                  <div className="empty-state-desc">
                    {routes.length === 0
                      ? '点击“自动重建”可按当前模型可用性生成路由。'
                      : '请调整品牌筛选、搜索词或排序条件。'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      );
}
