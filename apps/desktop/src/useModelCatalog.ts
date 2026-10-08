import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { ModelConfig, ModelDescriptor, ModelCatalogSnapshot } from '@lodex/contracts';
import { modelCatalog } from './bridge';
import { ModelCatalogLoader, modelCatalogSource } from './model-catalog';

export function useModelCatalog(config: ModelConfig, autoLoad: boolean) {
  const source = modelCatalogSource(config);
  const currentSource = useRef(source);
  currentSource.current = source;
  const loader = useRef(new ModelCatalogLoader<ModelCatalogSnapshot>());
  const mounted = useRef(true);
  const [state, setState] = useState<{
    source: string;
    models: ModelDescriptor[];
    error: string;
    loading: boolean;
    notice?: string;
  }>({ source: '', models: [], error: '', loading: false });

  async function load(refresh: boolean) {
    setState((state) => ({
      source,
      models: state.source === source ? state.models : [],
      error: '',
      loading: true,
    }));
    const request = loader.current.load(
      source,
      () => modelCatalog(config.provider, config.baseUrl, refresh),
      refresh,
    );
    const current = () =>
      mounted.current &&
      currentSource.current === source &&
      loader.current.isCurrent(source, request);
    try {
      const result = await request;
      if (!current()) return undefined;
      const notice = [
        result.notice,
        result.source === 'cache'
          ? localize('저장된 목록 · {0}', new Date(result.fetchedAt).toLocaleString())
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      setState({ source, models: result.models, error: '', loading: false, notice });
      return result.models;
    } catch (error) {
      if (current())
        setState({
          source,
          models: [],
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      return undefined;
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (autoLoad) void load(false);
  }, [source, autoLoad]);

  return {
    catalog: state.source === source ? state.models : [],
    catalogError: state.source === source ? state.error : '',
    catalogNotice: state.source === source ? state.notice : '',
    catalogLoading: state.source === source && state.loading,
    refreshCatalog: () => load(true),
  };
}
