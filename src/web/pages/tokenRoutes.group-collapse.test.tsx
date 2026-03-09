import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock, getBrandMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutes: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
    updateRoute: vi.fn(),
    addRoute: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: ({ brand, icon, model }: { brand?: { name?: string } | null; icon?: string | null; model?: string | null }) => (
    <span>{brand?.name || icon || model || ''}</span>
  ),
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: (...args: unknown[]) => getBrandMock(...args),
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

function findInputByPlaceholder(root: ReactTestInstance, placeholderText: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'input'
    && typeof node.props.placeholder === 'string'
    && node.props.placeholder.includes(placeholderText)
  ));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes grouped source models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.updateRoute.mockResolvedValue({});
    apiMock.addRoute.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('collapses source-model groups by default for wildcard routes', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 're:^claude-opus-(4-6|4-5)$',
        displayName: 'claude-opus-4-6',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'claude-opus-4-5',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { name: 'site-a' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
          {
            id: 12,
            accountId: 102,
            tokenId: 1002,
            sourceModel: 'claude-opus-4-6',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_b' },
            site: { name: 'site-b' },
            token: { id: 1002, name: 'token-b', accountId: 102, enabled: true, isDefault: true },
          },
        ],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('claude-opus-4-5');
      expect(text).toContain('claude-opus-4-6');
      expect(text).not.toContain('user_a');
      expect(text).not.toContain('user_b');
    } finally {
      root?.unmount();
    }
  });

  it('expands a source-model group after user click', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 're:^claude-opus-(4-6|4-5)$',
        displayName: 'claude-opus-4-6',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'claude-opus-4-5',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { name: 'site-a' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root.root)).not.toContain('user_a');

      const toggleButton = findButtonByText(root.root, 'claude-opus-4-5');
      await act(async () => {
        toggleButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('user_a');
    } finally {
      root?.unmount();
    }
  });

  it('renders missing-token site tags with interactive hover class', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-5.2-codex',
        displayName: 'gpt-5.2-codex',
        enabled: true,
        channels: [],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      modelsWithoutToken: {
        'gpt-5.2-codex': [
          {
            accountId: 101,
            username: 'linuxdo_11494',
            siteId: 11,
            siteName: 'Wong',
          },
        ],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteButton = findButtonByText(root.root, 'Wong');
      expect(String(siteButton.props.className || '')).toContain('missing-token-site-tag');
    } finally {
      root?.unmount();
    }
  });

  it('does not render missing-token site tags when the hint lacks a valid account id', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-5.2-codex',
        displayName: 'gpt-5.2-codex',
        enabled: true,
        channels: [],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      modelsWithoutToken: {
        'gpt-5.2-codex': [
          {
            accountId: 0,
            username: 'shenmo-direct',
            siteId: 12,
            siteName: '神墨',
          },
        ],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).not.toContain('待注册站点');
      expect(text).not.toContain('神墨');
    } finally {
      root?.unmount();
    }
  });

  it('maps endpoint types to expected brand icons in filter panel', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-5.2-codex',
        displayName: 'gpt-5.2-codex',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'gpt-5.2-codex',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { id: 1, name: 'Wong' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {
        'gpt-5.2-codex': ['openai', 'gemini', 'anthropic'],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('chatgpt');
      expect(text).toContain('gemini');
      expect(text).toContain('claude');
    } finally {
      root?.unmount();
    }
  });

  it('shows newly categorized brands in the route brand filter', async () => {
    getBrandMock.mockImplementation((modelName: string) => {
      if (String(modelName).includes('nvidia/vila')) {
        return {
          name: 'NVIDIA',
          icon: 'nvidia-color',
          color: 'linear-gradient(135deg,#76b900,#4a8c0b)',
        };
      }
      return null;
    });
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 91,
        modelPattern: 'nvidia/vila',
        displayName: 'nvidia/vila',
        enabled: true,
        channels: [],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('NVIDIA');
      expect(collectText(root.root)).not.toContain('查看未归类品牌路由');
    } finally {
      root?.unmount();
    }
  });

  it('falls back to site platform endpoint grouping when endpoint metadata cache is empty', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-4o-mini',
        displayName: 'gpt-4o-mini',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: null,
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { id: 1, name: 'site-a', platform: 'new-api' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {},
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('接口能力');
      expect(text).toContain('openai');
    } finally {
      root?.unmount();
    }
  });

  it('still shows endpoint group section with empty hint when no endpoint data can be inferred', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'custom-model-without-channel',
        displayName: 'custom-model-without-channel',
        enabled: true,
        channels: [],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {},
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('接口能力');
      expect(text).toContain('暂无接口能力数据');
    } finally {
      root?.unmount();
    }
  });

  it('hides exact routes covered by a group route from the main route list', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'minimax-m2.1',
        displayName: 'minimax-m2.1',
        enabled: true,
        channels: [],
      },
      {
        id: 2,
        modelPattern: 'minimaxai/minimax-m2.1',
        displayName: 'minimaxai/minimax-m2.1',
        enabled: true,
        channels: [],
      },
      {
        id: 3,
        modelPattern: 're:^(minimax-m2\\.1|minimaxai/minimax-m2\\.1)$',
        displayName: 'minimax2.1',
        enabled: true,
        channels: [],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const normalizedText = collectText(root.root).replace(/\s+/g, '');
      expect(normalizedText).toContain('共1条路由');
      expect(normalizedText).not.toContain('共3条路由');
    } finally {
      root?.unmount();
    }
  });

  it('enters edit mode and seeds the group form with the current route values', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 31,
        modelPattern: 're:^claude-(opus|sonnet)-4-6$',
        displayName: 'claude-4-6-group',
        displayIcon: 'anthropic',
        enabled: true,
        channels: [],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const editButton = findButtonByText(root.root, '编辑群组');
      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      expect(findInputByPlaceholder(root.root, '群组显示名').props.value).toBe('claude-4-6-group');
      expect(findInputByPlaceholder(root.root, '模型匹配').props.value).toBe('re:^claude-(opus|sonnet)-4-6$');
      expect(collectText(root.root)).toContain('保存群组');
    } finally {
      root?.unmount();
    }
  });

  it('updates route metadata from edit mode and reloads routes afterwards', async () => {
    apiMock.getRoutes
      .mockResolvedValueOnce([
        {
          id: 41,
          modelPattern: 're:^claude-.*$',
          displayName: 'old-group',
          displayIcon: '',
          enabled: true,
          channels: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 41,
          modelPattern: 're:^claude-.*$',
          displayName: 'new-group',
          displayIcon: '',
          enabled: true,
          channels: [],
        },
      ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        findButtonByText(root.root, '编辑群组').props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        findInputByPlaceholder(root.root, '群组显示名').props.onChange({ target: { value: 'new-group' } });
      });

      await act(async () => {
        findButtonByText(root.root, '保存群组').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(41, expect.objectContaining({
        displayName: 'new-group',
        modelPattern: 're:^claude-.*$',
      }));
      expect(apiMock.getRoutes).toHaveBeenCalledTimes(2);
    } finally {
      root?.unmount();
    }
  });

  it('reloads route data after saving an edited model pattern', async () => {
    apiMock.getRoutes
      .mockResolvedValueOnce([
        {
          id: 51,
          modelPattern: 're:^claude-.*$',
          displayName: 'group-a',
          displayIcon: '',
          enabled: true,
          channels: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 51,
          modelPattern: 're:^gemini-.*$',
          displayName: 'group-a',
          displayIcon: '',
          enabled: true,
          channels: [],
        },
      ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        findButtonByText(root.root, '编辑群组').props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        findInputByPlaceholder(root.root, '模型匹配').props.onChange({ target: { value: 're:^gemini-.*$' } });
      });

      await act(async () => {
        findButtonByText(root.root, '保存群组').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(51, expect.objectContaining({
        modelPattern: 're:^gemini-.*$',
      }));
      expect(apiMock.getRoutes).toHaveBeenCalledTimes(2);
    } finally {
      root?.unmount();
    }
  });
});
