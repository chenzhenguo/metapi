import { FastifyInstance } from 'fastify';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { getDownstreamRoutingPolicy } from './downstreamPolicy.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { isModelAllowedByPolicyOrAllowedRoutes } from '../../services/downstreamApiKeyService.js';

function isSearchPseudoModel(modelName: string): boolean {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '__search' || /^__.+_search$/.test(normalized);
}

export async function modelsProxyRoute(app: FastifyInstance) {
  app.get('/v1/models', async (request) => {
    const downstreamPolicy = getDownstreamRoutingPolicy(request);

    const readModels = async () => {
      const deduped = Array.from(new Set(await tokenRouter.getAvailableModels()))
        .filter((modelName) => !isSearchPseudoModel(modelName))
        .sort();
      const allowed: string[] = [];
      for (const modelName of deduped) {
        if (!await isModelAllowedByPolicyOrAllowedRoutes(modelName, downstreamPolicy)) {
          continue;
        }
        const decision = await tokenRouter.explainSelection(modelName, [], downstreamPolicy);
        if (typeof decision.selectedChannelId === 'number') {
          allowed.push(modelName);
        }
      }
      return allowed;
    };

    let models = await readModels();
    if (models.length === 0) {
      await refreshModelsAndRebuildRoutes();
      models = await readModels();
    }

    const wantsClaudeFormat = typeof request.headers['anthropic-version'] === 'string'
      || typeof request.headers['x-api-key'] === 'string';
    if (wantsClaudeFormat) {
      const data = models.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date().toISOString(),
      }));
      return {
        data,
        first_id: data[0]?.id || null,
        last_id: data[data.length - 1]?.id || null,
        has_more: false,
      };
    }

    return {
      object: 'list',
      data: models.map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'metapi',
      })),
    };
  });
}
