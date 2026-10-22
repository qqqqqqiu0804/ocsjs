/**
 * AI 兜底扩展测试
 *
 * 运行：node node_modules/tsx/dist/cli.mjs tests/ai-answerer.test.ts
 *
 * 覆盖：
 * 1. 判断题纯字母答案（A/B）能被 resolveJudgement 正确解析（回归）
 * 2. 配置归一化：默认关闭、缺字段不启用
 * 3. 隐私：redact 正则剔除、maxChars 截断
 * 4. 提示词构造：单选/多选/判断/填空
 * 5. 字母抽取：过滤越界字母、去重、排序
 */

import { resolveJudgement } from '../packages/core/src/core/worker/resolvers/judgement';
import {
	normalizeConfig,
	buildPayloadText,
	buildPrompt,
	extractLetters,
	splitOptions,
	requestAnswer
} from '../packages/core/src/core/answer-wrapper/ai.answerer';

let pass = 0;
let fail = 0;

function eq(name: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
	} else {
		fail++;
		console.log(`  ❌ ${name}\n     实际: ${a}\n     期望: ${e}`);
	}
}

// ========== 1. 判断题纯字母回归 ==========
console.log('\n  判断题纯字母回归');
{
	const pairs: Array<[string, string[], string | undefined]> = [
		['A', ['正确', '错误'], '正确'],
		['B', ['正确', '错误'], '错误'],
		['A', ['对', '错'], '对'],
		['B', ['对', '错'], '错'],
		['A', ['√', '×'], '√'],
		['B', ['√', '×'], '×'],
		['A', ['错误', '正确'], '错误'],
		['B', ['错误', '正确'], '正确'],
		['A', ['是', '否'], '是'],
		['B', ['是', '否'], '否'],
		[' A ', ['正确', '错误'], '正确'],
		['A.', ['正确', '错误'], '正确']
	];
	for (const [a, opts, expect] of pairs) {
		const r = resolveJudgement([[a]], opts);
		eq(`字母 ${a.trim()} + [${opts.join('/')}]`, r.option, expect);
	}

	// 越界字母不得命中
	eq('越界字母 C 落空', resolveJudgement([['C']], ['正确', '错误']).finish, false);
	// 非判断题性质的两选项不得被字母兜底误判
	eq('普通两选项不误判', resolveJudgement([['A']], ['苹果', '香蕉']).finish, false);
	// 原有文本答案仍然工作
	eq('文本"对"仍命中', resolveJudgement([['对']], ['对', '错']).option, '对');
	eq('文本"错误"仍命中', resolveJudgement([['错误']], ['正确', '错误']).option, '错误');
}

// ========== 2. 配置归一化 ==========
console.log('\n  配置归一化');
eq('未配置 -> undefined', normalizeConfig(undefined), undefined);
eq('enabled=false -> undefined', normalizeConfig({ enabled: false }), undefined);
eq('缺 baseUrl -> undefined', normalizeConfig({ enabled: true, model: 'm' }), undefined);
eq('缺 model -> undefined', normalizeConfig({ enabled: true, baseUrl: 'http://x/v1' }), undefined);
{
	const cfg = normalizeConfig({
		enabled: true,
		baseUrl: 'https://example.com/v1///',
		model: 'demo',
		timeoutSeconds: 1,
		maxChars: 10
	});
	eq('末尾斜杠被去除', cfg?.baseUrl, 'https://example.com/v1');
	eq('超时下限 5s', cfg?.timeoutSeconds, 5);
	eq('字符下限 80', cfg?.maxChars, 80);
	eq('apiKey 默认为空', cfg?.apiKey, '');
	eq('fallbackOnly 默认 true', cfg?.fallbackOnly, true);
}

// ========== 3. 隐私裁剪 ==========
console.log('\n  隐私裁剪');
{
	const redact = [/\d{6,}/g, /张三/g];
	const out = buildPayloadText('学号20231001张三的题目', '甲|乙', { maxChars: 1200, redact });
	eq('学号被剔除', out.title.includes('20231001'), false);
	eq('姓名被剔除', out.title.includes('张三'), false);
	eq('正常文字保留', out.title, '学号的题目');
}
{
	const out = buildPayloadText('x'.repeat(5000), 'ab', { maxChars: 100, redact: [] });
	eq('超长题干被截断', out.title.length, 100);
}
{
	// 非法正则应被安全忽略，不影响启用
	const cfg = normalizeConfig({
		enabled: true,
		baseUrl: 'http://x/v1',
		model: 'm',
		redact: ['([bad', 'OK']
	});
	eq('非法正则被丢弃', cfg?.redact.length, 1);
}

// ========== 4. 提示词构造 ==========
console.log('\n  提示词构造');
eq('选项拆分', splitOptions('甲|乙\n丙'), ['甲', '乙', '丙']);
{
	const p = buildPrompt('题目', '甲|乙|丙|丁', 'single');
	eq('单选题期望字母', p.expectLetter, true);
	eq('单选题含 A. 前缀', p.user.includes('A. 甲'), true);
	eq('单选题规则', p.user.includes('只输出一个字母'), true);
}
{
	const p = buildPrompt('题目', '甲|乙|丙|丁', 'multiple');
	eq('多选题规则', p.user.includes('按字母顺序输出全部正确项'), true);
}
{
	const p = buildPrompt('题目', '正确|错误', 'judgement');
	eq('判断题规则', p.user.includes('只输出 A 或 B'), true);
}
{
	const p = buildPrompt('填空题目', '', undefined);
	eq('填空题不需要字母', p.expectLetter, false);
	eq('填空题提示', p.user.includes('最简答案内容'), true);
}

// ========== 5. 字母抽取 ==========
console.log('\n  字母抽取');
eq('纯字母', extractLetters('D', 4), ['D']);
eq('带文字答案前缀', extractLetters('答案：B', 4), ['B']);
eq('多选乱序去重排序', extractLetters('CAB', 4), ['A', 'B', 'C']);
eq('越界字母被过滤', extractLetters('ABCD', 2), ['A', 'B']);
eq('无字母', extractLetters('不知道', 4), []);
eq('重复字母去重', extractLetters('AA', 4), ['A']);

// ========== 6. 未启用时不发请求 ==========
async function testDisabled() {
	console.log('\n  未启用时零请求');
	const r = await requestAnswer('题目', '甲|乙', 'single', undefined);
	eq('未配置返回 undefined', r, undefined);
	const r2 = await requestAnswer('题目', '甲|乙', 'single', { enabled: false });
	eq('enabled=false 返回 undefined', r2, undefined);
}

// ========== 7. 兜底包装器 ==========
async function testFallbackWrapper() {
	console.log('\n  兜底包装器');
	const { withAiFallback, hasUsableAnswer } = await import('../packages/core/src/core/worker/ai.fallback');

	const fakeCtx = { elements: { title: [], options: [] }, type: 'single' } as any;
	const fakeElements = {} as any;

	// hasUsableAnswer 判定
	eq('空结果无可用答案', hasUsableAnswer([]), false);
	eq('空答案不算可用', hasUsableAnswer([{ name: 'x', results: [{ question: 'q', answer: '' }] }]), false);
	eq('有答案算可用', hasUsableAnswer([{ name: 'x', results: [{ question: 'q', answer: 'A' }] }]), true);

	// 未配置时：直通，且返回同一个函数引用
	const base = async () => [{ name: 'base', results: [{ question: 'q', answer: 'A' }] }];
	const wrapped = withAiFallback(base, undefined);
	eq('未配置时直通同一函数', wrapped === base, true);

	// enabled=false 时：同样直通
	const wrapped2 = withAiFallback(base, { enabled: false });
	eq('enabled=false 时直通', wrapped2 === base, true);

	// 已启用但常规题库有答案：不调用 AI，结果原样返回
	// 使用保留地址 TEST-NET-1（RFC 5737）中的不可达端点，仅为占位，不含真实服务信息
	const enabled = { enabled: true, baseUrl: 'http://192.0.2.1:9/v1', model: 'test-model' };
	const wrapped3 = withAiFallback(base, enabled);
	const res3 = await wrapped3(fakeElements, fakeCtx);
	eq('有答案时不追加 AI 结果', res3.length, 1);
	eq('有答案时保留原始来源', res3[0].name, 'base');

	// 常规题库无答案：AI 端点不可达时应静默失败，返回原始结果（不抛出）
	const emptyBase = async () => [{ name: 'base', results: [{ question: 'q', answer: '' }] }];
	const wrapped4 = withAiFallback(emptyBase, enabled);
	const res4 = await wrapped4(fakeElements, fakeCtx);
	eq('AI 不可达时不抛异常且返回原结果', Array.isArray(res4), true);
	eq('AI 不可达时结果数仍为 1', res4.length, 1);

	// 常规题库抛异常：应吞掉并返回数组（不向上抛）
	const throwBase = async () => {
		throw new Error('boom');
	};
	const wrapped5 = withAiFallback(throwBase, enabled);
	const res5 = await wrapped5(fakeElements, fakeCtx);
	eq('常规题库抛错时返回数组', Array.isArray(res5), true);
}

testDisabled()
	.then(testFallbackWrapper)
	.then(() => {
		console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${pass} 通过   ${fail} 失败   共 ${pass + fail} 项\n`);
		process.exit(fail === 0 ? 0 : 1);
	});
