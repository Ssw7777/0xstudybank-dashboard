import Link from "next/link";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { readStore } from "@/lib/store";
import { nextZerionKey, zerionRequest } from "@/lib/onchain/zerion-keys";
import {web3Credentials} from '@/lib/onchain/okx-web3';
import { parseTransactionRecords, type TransactionRecord } from "@/lib/transaction-records";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const cache = new Map<string, { at: number; records: TransactionRecord[]; more: boolean }>();
const operations: Record<string, string> = { send: "发送", receive: "接收", trade: "兑换", approve: "授权", deposit: "存入", withdraw: "取出", claim: "领取", execute: "合约调用" };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  if (!(await isAuthenticated())) redirect("/login");
  const state = await readStore();
  const { address = "" } = await searchParams;
  const wallet = state.wallets.find((item) => item.address.toLowerCase() === address.toLowerCase());
  const key = nextZerionKey();
  const cloudHistory=wallet?state.transactionHistory?.[wallet.address.toLowerCase()]:undefined;
  const usesWeb3=!!web3Credentials();
  let result = cloudHistory?{at:Date.parse(cloudHistory.at),records:cloudHistory.records,more:cloudHistory.more}:wallet ? cache.get(wallet.address.toLowerCase()) : undefined;
  let error = "";
  if (wallet && usesWeb3 && (!result || Date.now()-result.at>600_000))error='云端链上交易查询尚未完成或已超过10分钟，请查看钱包查询状态；不把余额差额视为转账。';
  if (wallet && !usesWeb3 && (!result || Date.now() - result.at > 300_000)) {
    result = undefined;
    if (!key) error = "未配置交易记录数据源。";
    else {
      try {
        const params = new URLSearchParams({ currency: "usd", "page[size]": "100", "filter[trash]": "only_non_trash", "filter[min_mined_at]": String(Date.now() - 7 * 86_400_000) });
        const response = await zerionRequest(() => fetch(`https://api.zerion.io/v1/wallets/${wallet.address.toLowerCase()}/transactions/?${params}`, {
          headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, Accept: "application/json" },
          cache: "no-store", signal: AbortSignal.timeout(20_000),
        }));
        if (!response.ok) throw new Error(`交易接口返回 HTTP ${response.status}，本次无法核验。`);
        const body = await response.json();
        result = { at: Date.now(), records: parseTransactionRecords(body), more: !!body.links?.next };
        cache.set(wallet.address.toLowerCase(), result);
      } catch (cause) {
        error = cause instanceof Error && cause.message.startsWith("交易接口") ? cause.message : "交易接口暂时不可用，本次无法核验。";
      }
    }
  }
  const label = (value: string) => state.wallets.find((item) => item.address.toLowerCase() === value.toLowerCase())?.name ?? value;
  return <main className="page"><div className="container transaction-page">
    <div className="section-head"><h1>链上交易核验</h1><Link className="btn btn-outline" href="/dashboard">返回看板</Link></div>
    <p className="muted">独立读取已确认的链上交易，不使用余额差额推断转账。{usesWeb3?'云端轮询并保存最近7天的记录，每个钱包最多100笔；未覆盖的链不能据此判断无交易。':'按需查询最近7天、最多100条；不代表后台全链实时监听。'}</p>
    <nav className="transaction-wallets">{state.wallets.map((item) => <Link prefetch={false} className="btn btn-outline" aria-current={item.id === wallet?.id ? "page" : undefined} key={item.id} href={`/transactions?address=${item.address}`}>{item.name}</Link>)}</nav>
    {!wallet && <p>请选择需要核验的钱包。</p>}
    {wallet && <section className="section">
      <h2>{wallet.name}</h2><p className="transaction-hash">{wallet.address}</p>
      {error && <p className="neg" role="alert">{error}</p>}
      {result && <>
        <p className="muted">{usesWeb3?'OKX OnchainOS':'Zerion'} · 查询时间 {new Date(result.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</p>
        <p className="notice">仅涵盖当前数据源及套餐支持的链；未返回记录不等于所有链均无交易。{result.more ? "数据源返回分页游标，本页不能据此认定历史完整。" : ""}</p>
        {!result.records.length && <p>数据源在此查询范围内未返回已确认的非垃圾交易。</p>}
        {result.records.map((tx) => <article className="transaction-record" key={`${tx.chain}:${tx.hash}`}>
          <div className="section-head"><strong>{operations[tx.operation] ?? tx.operation} · {tx.chain}</strong><span>{new Date(tx.minedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span></div>
          <div className="transaction-hash">交易哈希：{tx.hash}</div>
          {tx.transfers.length ? tx.transfers.map((transfer, index) => <div className="transaction-transfer" key={index}>
            <span className="transaction-hash" title={`${transfer.sender} → ${transfer.recipient}`}>{label(transfer.sender)} → {label(transfer.recipient)}</span>
            <strong>{transfer.quantity} {transfer.symbol}{transfer.valueUsd === null ? " · 未提供美元估值" : ` · $${transfer.valueUsd.toFixed(2)}`}</strong>
          </div>) : <p className="muted">此交易未返回代币转移明细（例如授权），不计为资金转账。</p>}
        </article>)}
      </>}
    </section>}
  </div></main>;
}
