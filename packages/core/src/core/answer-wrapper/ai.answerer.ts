import { SearchInformation, Result } from '../answer-wrapper/interface';
import { request } from '../utils/request';
import { $ } from '../../utils';

/**
 * AI 答题兜底（可选扩展）
 *
 * 设计目标：当常规题库全部未命中时，交给一个 OpenAI 兼容的推理端点现场作答。
 * 该模块**不内置任何服务地址、密钥或平台标识**，完全由用户自行配置，
 * 默认关闭，不配置则不产生任何网络请求。
 *
 * 与 OCS 常规题库的关系：
 * - 常规题库（AnswererWrapper）先执行；本兜底仅在其结果为空或未解析出答案时介入。
 * - 若不启用，行为与未安装本扩展完全一致。
 *
 * 隐私约定：
 * - 仅发送题干文本与选项文本，不发送 cookie、账号信息、页面 URL、截图。
 * - 可配置 `redact` 正则列表，在发送前剔除题干中的敏感片段（如学号、姓名）。
 * - 可配置 `maxChars` 截断超长题干，避免把整页正文带出去。
 * - 不落盘、不缓存请求内容；日志默认关闭。
 */

/** AI 兜底配置 */
export interface AiAnswererConfig {
	/** 是否启用。默认 false，未启用时不发起任何请求 */
	enabled?: boolean;
	/** OpenAI 兼容端点，形如 https://example.com/v1（末尾无需 /chat/completions） */
	baseUrl?: string;
	/** 访问密钥。可用 ${AI_KEY} 之类占位由宿主注入；也可留空对接本地无鉴权服务 */
	apiKey?: string;
	/** 模型名 */
	model?: string;
	/** 超时秒数，默认 45 */
	timeoutSeconds?: number;
	/** 单题最大题干字符数，超出截断，默认 1200 */
	maxChars?: number;
	/** 发送前剔除的敏感片段正则（字符串形式），默认空 */
	redact?: string[];
	/** 是否在控制台打印请求概要（不含题干正文），默认 false */
	verbose?: boolean;
	/**
	 * 仅当常规题库未能解析出结果时调用，默认 true。
	 * 置为 false 则与常规题库并行请求（更快，但会多消耗额度）。
	 */
	fallbackOnly?: boolean;
	/** 附加请求头 */
	headers?: Record<string, string>;
}

/** 归一化后的 AI 兜底配置（内部使用） */
interface NormalizedAiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutSeconds: number;
	maxChars: number;
	redact: RegExp[];
	verbose: boolean;
	fallbackOnly: boolean;
	headers: Record<string, string>;
}

const DEFAULTS: NormalizedAiConfig = {
	baseUrl: '',
	apiKey: '',
	model: '',
	timeoutSeconds: 45,
	maxChars: 1200,
	redact: [],
	verbose: false,
	fallbackOnly: true,
	headers: {}
};

/** 将用户配置归一化为内部结构；返回 undefined 表示不可用 */
export function normalizeConfig(config?: AiAnswererConfig): NormalizedAiConfig | undefined {
	if (!config || !config.enabled) return undefined;
	const baseUrl = String(config.baseUrl ?? '').trim();
	const model = String(config.model ?? '').trim();
	// 缺少端点或模型时视为未正确配置，直接不启用，避免半配置状态下疯狂重试
	if (!baseUrl || !model) return undefined;

	const redact = (config.redact ?? [])
		.map((p) => {
			try {
				return new RegExp(p, 'g');
			} catch {
				return undefined;
			}
		})
		.filter((r): r is RegExp => !!r);

	return {
		baseUrl: baseUrl.replace(/\/+$/, ''),
		apiKey: String(config.apiKey ?? '').trim(),
		model,
		timeoutSeconds: Math.max(5, Number(config.timeoutSeconds ?? DEFAULTS.timeoutSeconds)),
		maxChars: Math.max(80, Number(config.maxChars ?? DEFAULTS.maxChars)),
		redact,
		verbose: !!config.verbose,
		fallbackOnly: config.fallbackOnly !== false,
		headers: { ...(config.headers ?? {}) }
	};
}

/** 构造提供给模型的输入，做隐私裁剪 */
export function buildPayloadText(
	title: string,
	options: string,
	cfg: Pick<NormalizedAiConfig, 'maxChars' | 'redact'>
): { title: string; options: string } {
	const clean = (s: string) => {
		let out = String(s ?? '');
		for (const re of cfg.redact) {
			re.lastIndex = 0;
			out = out.replace(re, '');
		}
		return out.trim().slice(0, cfg.maxChars);
	};
	return { title: clean(title), options: clean(options) };
}

/** 根据题型与选项生成提示词 */
export function buildPrompt(
	title: string,
	options: string,
	type: string | undefined
): { system: string; user: string; expectLetter: boolean } {
	const opts = splitOptions(options);
	const letterable = opts.length >= 2;
	const system =
		'你是严谨的答题助手。只输出答案，不输出解释、不输出多余文字。' + (letterable ? '答案必须是选项字母。' : '');

	if (!letterable) {
		return {
			system,
			user: `题目：${title}\n请直接给出最简答案内容。`,
			expectLetter: false
		};
	}

	const isJudge = opts.length === 2 && isJudgementPair(opts);
	const isMulti = (type ?? '').toLowerCase().includes('multiple') || type === 'multiple';
	const lines = opts.map((t, i) => `${String.fromCharCode(65 + i)}. ${t}`).join('\n');

	const rule = isJudge
		? '这是判断题，只输出 A 或 B。'
		: isMulti
		? '这是多选题，按字母顺序输出全部正确项，如 ABD。'
		: '这是单选题，只输出一个字母。';

	return {
		system,
		user: `题目：${title}\n选项：\n${lines}\n${rule}`,
		expectLetter: true
	};
}

/** 拆分选项文本（OCS 以 | 或换行分隔） */
export function splitOptions(options: string): string[] {
	return String(options ?? '')
		.split(/[|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const TRUE_WORDS = ['正确', '对', '是', '√', 'true'];
const FALSE_WORDS = ['错误', '错', '否', '×', 'x', 'false'];
function isJudgementPair(opts: string[]): boolean {
	const has = (words: string[]) => opts.some((o) => words.some((w) => o.toLowerCase().trim() === w.toLowerCase()));
	return (has(TRUE_WORDS) && has(FALSE_WORDS)) || (has(FALSE_WORDS) && has(TRUE_WORDS));
}

/** 从模型回复中抽取选项字母，并过滤非法字母 */
export function extractLetters(text: string, optionCount: number): string[] {
	const valid = 'ABCDEFGH'.slice(0, Math.max(0, optionCount));
	const upper = String(text ?? '').toUpperCase();
	const explicit = upper.match(/答案\s*[:：是]?\s*([A-H]{1,8})/);
	const raw = explicit ? explicit[1] : (upper.match(/[A-H]/g) ?? []).join('');
	const kept = Array.from(new Set(raw.split('')))
		.filter((c) => valid.includes(c))
		.sort();
	return kept;
}

/**
 * 单题请求。成功返回答案文本（字母串或答案内容），失败返回 undefined。
 * 不抛出异常，避免中断整个答题流程。
 */
export async function requestAnswer(
	title: string,
	options: string,
	type: string | undefined,
	config?: AiAnswererConfig
): Promise<Result | undefined> {
	const cfg = normalizeConfig(config);
	if (!cfg) return undefined;

	const payloadText = buildPayloadText(title, options, cfg);
	if (!payloadText.title) return undefined;
	const prompt = buildPrompt(payloadText.title, payloadText.options, type);

	const url = `${cfg.baseUrl}/chat/completions`;
	const body = {
		model: cfg.model,
		messages: [
			{ role: 'system', content: prompt.system },
			{ role: 'user', content: prompt.user }
		],
		temperature: 0,
		max_tokens: 64,
		stream: false
	};

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...cfg.headers
	};
	if (cfg.apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${cfg.apiKey}`;
	}

	try {
		if (cfg.verbose) {
			console.info('[ai-answerer] request', { model: cfg.model, letters: prompt.expectLetter });
		}
		const response: any = await Promise.race([
			request(url, {
				method: 'post',
				type: 'fetch',
				responseType: 'json',
				headers,
				data: body
			}),
			$.sleep(cfg.timeoutSeconds * 1000)
		]);
		if (!response) return undefined;

		const content: string =
			response?.choices?.[0]?.message?.content ?? response?.data?.choices?.[0]?.message?.content ?? '';
		if (!content) return undefined;

		const optionList = splitOptions(options);
		let answer: string;
		if (prompt.expectLetter) {
			const letters = extractLetters(content, optionList.length);
			if (!letters.length) return undefined;
			answer = letters.join('');
		} else {
			answer = String(content).trim().slice(0, 200);
			if (!answer) return undefined;
		}

		return { question: title, answer };
	} catch (error) {
		if (cfg.verbose) {
			console.warn('[ai-answerer] request failed', (error as any)?.message ?? error);
		}
		return undefined;
	}
}

/**
 * 批量兜底：为未解析出答案的题目补答，包装成与常规题库一致的 SearchInformation，
 * 便于上层统一处理。
 */
export async function aiSearchInformation(
	env: { title?: string; options?: string; type?: string },
	config?: AiAnswererConfig
): Promise<SearchInformation | undefined> {
	const result = await requestAnswer(env.title ?? '', env.options ?? '', env.type, config);
	if (!result) return undefined;
	return {
		name: 'AI 兜底',
		url: '',
		homepage: '',
		results: [result]
	};
}
