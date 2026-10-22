import { SearchInformation } from '../answer-wrapper/interface';
import { AiAnswererConfig, aiSearchInformation, normalizeConfig } from '../answer-wrapper/ai.answerer';
import { RawElements, WorkContext } from './interface';

/**
 * 把常规查题器包一层 AI 兜底
 *
 * 行为约定：
 * 1. **默认零影响**：未提供或未启用 AI 配置时，直接返回原查题器的结果，不做任何额外处理。
 * 2. **仅补空缺**：仅当常规题库返回的结果中没有任何一条带有效答案时，才调用 AI 兜底。
 *    `fallbackOnly: false` 时可改为并行请求（更快，但会增加额度消耗）。
 * 3. **失败不外抛**：AI 请求异常一律吞掉，不影响原有答题流程。
 * 4. **可追溯**：AI 补答会以独立的 `SearchInformation` 追加在结果末尾，
 *    便于结果面板看出答案来自常规题库还是 AI。
 *
 * @param answerer 原有查题器（通常是 defaultAnswerWrapperHandler 的绑定版本）
 * @param config   AI 兜底配置；未启用时本函数等价于直通
 */
export function withAiFallback<E extends RawElements>(
	answerer: (elements: E, ctx: WorkContext<E>) => Promise<SearchInformation[]> | SearchInformation[],
	config?: AiAnswererConfig
) {
	const cfg = normalizeConfig(config);
	// 未正确配置：返回原函数本身，保证零行为变化
	if (!cfg) return answerer;

	return async (elements: E, ctx: WorkContext<E>): Promise<SearchInformation[]> => {
		const env = buildEnv(elements, ctx);

		// 非 fallbackOnly 模式：与常规题库并行，谁先给出答案都能用
		if (!cfg.fallbackOnly) {
			const [original, ai] = await Promise.all([
				Promise.resolve(answerer(elements, ctx)).catch(() => [] as SearchInformation[]),
				aiSearchInformation(env, config)
			]);
			const merged = [...(original ?? [])];
			if (ai) merged.push(ai);
			return merged;
		}

		// 默认模式：先跑常规题库，全部无答案时才问 AI
		let original: SearchInformation[] = [];
		try {
			original = (await answerer(elements, ctx)) ?? [];
		} catch (err) {
			// 常规题库整体失败时仍尝试 AI，但不改变原有错误语义之外的流程
			original = [];
		}

		if (hasUsableAnswer(original)) return original;

		const ai = await aiSearchInformation(env, config);
		return ai ? [...original, ai] : original;
	};
}

/** 是否已存在可用答案（任意一条非空答案即算命中） */
export function hasUsableAnswer(infos: SearchInformation[]): boolean {
	return infos.some((info) => info.results.some((r) => String(r.answer ?? '').trim().length > 0));
}

/** 从上下文已解析的元素数组中提取题干/选项/题型，供 AI 使用 */
function buildEnv<E extends RawElements>(
	elements: E,
	ctx: WorkContext<E>
): { title?: string; options?: string; type?: string } {
	const searched = ctx.elements as Record<string, unknown>;

	const pickTexts = (key: string): string => {
		const value = searched?.[key] as unknown;
		if (!Array.isArray(value)) return '';
		return value
			.map((el) => {
				const node = el as HTMLElement | undefined;
				return node?.innerText ?? '';
			})
			.map((s) => String(s).trim())
			.filter(Boolean)
			.join(key === 'options' ? '|' : ' ');
	};

	const title = pickTexts('title');
	const options = pickTexts('options');
	const type = typeof ctx.type === 'string' ? ctx.type : undefined;
	return { title, options, type };
}
