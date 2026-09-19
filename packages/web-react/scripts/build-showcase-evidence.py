#!/usr/bin/env python3
"""Offline, stdlib-only showcase builder. --check recomputes all five files read-only."""
import argparse
import base64
import collections
import csv
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import io
import json
import math
from pathlib import Path
import sys
import zipfile

WEB = Path(__file__).resolve().parents[1]
CASES = WEB / 'public/tutorials/cases'
BIKE = 'research-bike-demand'
BRIEF = 'general-public-data-brief'
LIMITATIONS = [
    '公开数据样例实作，不是客户项目，不是全程平台会话回放。',
    '仅为历史数据描述性分析，没有预测准确率、因果推断或经营收益承诺。',
    '生成时间不是数据年份；本次离线复算不代表重新联网获取源站最新值。',
]
COLORS = ['#0e8877', '#5368cb', '#da863e']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def jbytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def inline(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).replace('<', '\\u003c')


def csvbytes(rows, columns):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode()


def file_record(path, data):
    return {'path': '/' + path.relative_to(WEB / 'public').as_posix(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def passed(name):
    return {'name': name, 'passed': True}


STYLE = r'''
:root{color-scheme:light;--ink:#183c38;--muted:#61756e;--line:#dfe8e2;--paper:#fffef9;--accent:#0e8877;--soft:#e9f3ee}*{box-sizing:border-box}body{margin:0;background:#f3f5ef;color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}a{color:var(--accent);text-underline-offset:4px}button,select{font:inherit}button{cursor:pointer}button:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #5b68ca;outline-offset:4px}main{max-width:1140px;margin:auto;padding:38px 30px 50px}.topline{display:flex;justify-content:space-between;gap:12px;font-size:12px;letter-spacing:.1em}.brand{font-weight:800}.tag{border:1px solid #c5d9ca;border-radius:30px;padding:3px 10px;letter-spacing:0}.hero{padding:38px 0 30px;max-width:840px}.eyebrow{font:700 11px/1.5 monospace;letter-spacing:.17em;color:var(--accent);margin:0 0 15px}h1{font-size:clamp(29px,4.8vw,47px);line-height:1.23;letter-spacing:-.04em;margin:0 0 18px}h1 em{font-style:normal;color:var(--accent)}.lead{color:var(--muted);max-width:720px;margin:0}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:0 0 22px}.stat{background:var(--paper);padding:20px 22px;border:1px solid var(--line);border-radius:16px}.stat small{display:block;color:var(--muted);font-size:12px}.stat strong{display:block;font-size:30px;font-weight:650;letter-spacing:-.04em;margin:3px 0}.stat span{font-size:12px;color:var(--muted)}.panel{background:var(--paper);border:1px solid var(--line);border-radius:19px;padding:25px;margin:0 0 20px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;flex-wrap:wrap}.panel h2{margin:0;font-size:20px;letter-spacing:-.02em}.hint{margin:5px 0 0;color:var(--muted);font-size:12px}.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:21px 0}.filters label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}select{background:white;border:1px solid #cddbd1;color:var(--ink);border-radius:8px;padding:7px 28px 7px 10px;min-height:39px}.live{padding:11px 14px;border-radius:9px;background:var(--soft);font-size:13px;min-height:45px;margin:14px 0}.chart-scroll{overflow-x:auto}.chart{display:block;width:100%;min-width:520px;height:auto}.chart text{fill:var(--muted);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.chart .grid{stroke:#e5ebe5;stroke-width:1}.chart rect{fill:var(--accent)}.chart .peak{fill:#5368cb}details{margin-top:18px;border-top:1px solid var(--line);padding-top:13px}summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--muted)}.table-wrap{overflow:auto;max-height:320px;margin-top:14px}table{border-collapse:collapse;min-width:470px;width:100%;font-size:12px;text-align:left;font-variant-numeric:tabular-nums}caption{text-align:left;color:var(--muted);padding-bottom:8px}th,td{border-bottom:1px solid var(--line);padding:9px 10px}th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--paper)}.grid-two{display:grid;grid-template-columns:1.4fr 1fr;gap:20px}.grid-two .panel{margin:0;min-width:0}.note-list{display:grid;gap:20px;margin-top:24px}.note{border-left:3px solid #bcd8c9;padding-left:15px}.note h3{font-size:14px;margin:0 0 5px}.note p{margin:0;color:var(--muted);font-size:12px}.source{margin:28px 0 0;font-size:12px;color:var(--muted)}.source h2{font-size:14px;color:var(--ink)}.source p{margin:8px 0}.downloads{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.downloads a{background:#fff;border:1px solid var(--line);padding:6px 12px;border-radius:8px;font-size:12px;text-decoration:none}.pillset{display:flex;flex-wrap:wrap;gap:8px;margin:19px 0}.pillset button{border:1px solid #cfddd4;color:var(--ink);background:transparent;padding:7px 13px;border-radius:30px;font-size:12px}.pillset button[aria-pressed=true]{background:var(--ink);color:white;border-color:var(--ink)}.countries{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.country{padding:20px;border-radius:13px;background:#f5f7f2;border-top:3px solid var(--accent)}.country h3{font-size:19px;margin:0 0 3px}.country .code{font-size:10px;letter-spacing:.15em;color:var(--muted)}.country strong{font-size:26px;display:block;margin:15px 0 0;font-weight:650}.country p{font-size:12px;color:var(--muted);margin:4px 0}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px}.dot{display:inline-block;width:7px;height:7px;background:var(--accent);border-radius:100%;margin-right:5px}.world-bar{display:grid;grid-template-columns:85px 1fr 115px;gap:14px;align-items:center;margin:24px 0;font-size:13px}.track{height:30px;background:#edf1eb;border-radius:5px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:5px;transition:width .25s}.bar-value{text-align:right;font-weight:650;font-variant-numeric:tabular-nums}.foot{margin-top:24px;border-top:1px solid var(--line);padding-top:13px;display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--muted)}.process{display:flex;gap:8px;flex-wrap:wrap;margin-top:24px;font-size:11px;color:var(--muted)}.process span{border:1px solid var(--line);border-radius:6px;padding:5px 8px}noscript{display:block;padding:18px;background:#fff4ce;border-radius:8px}@media(max-width:700px){main{padding:22px 15px 35px}.hero{padding:28px 0}.stats{gap:8px}.stat{padding:15px 12px}.stat strong{font-size:20px;overflow-wrap:anywhere}.stat span{font-size:10px;overflow-wrap:anywhere}.panel{padding:18px}.grid-two{grid-template-columns:1fr}.countries{grid-template-columns:1fr}.country{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.country strong{margin:0;text-align:right}.country p{text-align:right}.topline{font-size:10px}.world-bar{grid-template-columns:64px 1fr 92px;gap:9px;font-size:12px}.foot{flex-direction:column}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
'''
DOM = r'''
'use strict';
const $=id=>document.getElementById(id);
const fmt=(value,digits=0)=>value===null?'缺失':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits,minimumFractionDigits:digits});
function node(tag,attrs={},text=null){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==null)el.textContent=String(text);return el;}
function svgNode(tag,attrs={},text=null){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==null)el.textContent=String(text);return el;}
function cell(row,text){row.appendChild(node('td',{},text));}
'''


def page(title, body, script, generated_at):
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    csp = ("default-src 'none'; script-src 'sha256-" + digest + "'; style-src 'unsafe-inline'; "
           "img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
    return (f'<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n'
            f'<meta http-equiv="Content-Security-Policy" content="{html.escape(csp, quote=True)}">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'
            f'<title>{html.escape(title)} · 从简案例</title><style>{STYLE}</style></head><body><main>'
            '<header class="topline"><span class="brand">从简 / CASE STUDY</span><span class="tag">公开数据 · 真实计算 · 可复算</span></header>'
            '<noscript>筛选需要 JavaScript；可直接打开下方报告、CSV 和 JSON 查看全部结果。</noscript>'
            + body + '<footer class="foot"><span>不是演示数字，是可以带走、复算的成果。</span>'
            f'<span>成果生成：{html.escape(generated_at)} · UTC</span></footer></main>'
            f'<script>{script}</script></body></html>\n').encode()


def downloads():
    return ('<nav class="downloads" aria-label="下载成果"><a href="report.md">阅读完整报告 ↗</a>'
            '<a href="derived.csv" download>下载可复算 CSV</a><a href="metrics.json">查看指标 JSON</a>'
            '<a href="manifest.json">来源与校验记录</a></nav>')


def read_bike():
    path = CASES / BIKE / 'inputs/bike-sharing-dataset.zip'
    raw = path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        tables = {name: list(csv.DictReader(io.StringIO(archive.read(name).decode())))
                  for name in ('day.csv', 'hour.csv')}
        readme = archive.read('Readme.txt').decode()
    require('2011' in readme and '2012' in readme, 'Source metadata missing')
    for name, rows in tables.items():
        require(bool(rows), name + ' empty')
        require(all(all(v is not None and v.strip() != '' for v in row.values()) for row in rows),
                name + ': blank cells require explicit handling, not silent dropping')
        for r in rows:
            date = dt.date.fromisoformat(r['dteday'])
            require(int(r['yr']) + 2011 == date.year and int(r['mnth']) == date.month, 'Inconsistent calendar')
            require(int(r['workingday']) in (0, 1) and int(r['weathersit']) in (1, 2, 3, 4), 'Invalid group code')
            require(all(int(r[k]) >= 0 for k in ('casual', 'registered', 'cnt')), 'Negative count')
            require(int(r['casual']) + int(r['registered']) == int(r['cnt']), 'Components mismatch')
            if name == 'hour.csv':
                require(0 <= int(r['hr']) <= 23, 'Invalid hour')
    days, hours = tables['day.csv'], tables['hour.csv']
    require(len({r['dteday'] for r in days}) == len(days), 'Duplicate daily dates')
    require(len({(r['dteday'], r['hr']) for r in hours}) == len(hours), 'Duplicate hourly keys')
    first, last = min(r['dteday'] for r in days), max(r['dteday'] for r in days)
    require((first, last) == ('2011-01-01', '2012-12-31'), 'Unexpected documented data period')
    expected_days = (dt.date.fromisoformat(last) - dt.date.fromisoformat(first)).days + 1
    require(expected_days == len(days), 'Daily calendar gaps')
    daily = collections.defaultdict(collections.Counter)
    for r in hours:
        for k in ('casual', 'registered', 'cnt'):
            daily[r['dteday']][k] += int(r[k])
    require(set(daily) == {r['dteday'] for r in days}, 'Daily/hourly date mismatch')
    require(all(all(daily[r['dteday']][k] == int(r[k]) for k in ('casual', 'registered', 'cnt')) for r in days),
            'Hourly totals fail daily reconciliation')
    rows = [{'date': r['dteday'], 'year': int(r['yr']) + 2011, 'month': int(r['mnth']),
             'hour': int(r['hr']), 'workingday': int(r['workingday']), 'weather': int(r['weathersit']),
             'casual': int(r['casual']), 'registered': int(r['registered']), 'total': int(r['cnt'])} for r in hours]
    groups = {}
    for year in ('all', '2011', '2012'):
        for kind in ('all', 'working', 'nonworking'):
            selected = [r for r in rows if (year == 'all' or r['year'] == int(year))
                        and (kind == 'all' or r['workingday'] == int(kind == 'working'))]
            hourly, monthly = [], []
            for hour in range(24):
                bucket = [r for r in selected if r['hour'] == hour]
                hourly.append({'hour': hour, 'observations': len(bucket),
                               **{k: sum(r[k] for r in bucket) for k in ('total', 'casual', 'registered')}})
            for month in sorted({r['date'][:7] for r in selected}):
                bucket = [r for r in selected if r['date'].startswith(month)]
                monthly.append({'month': month, 'observations': len(bucket),
                                **{k: sum(r[k] for r in bucket) for k in ('total', 'casual', 'registered')}})
            totals = {k: sum(r[k] for r in selected) for k in ('total', 'casual', 'registered')}
            require(all(sum(h[k] for h in hourly) == totals[k] == sum(m[k] for m in monthly) for k in totals),
                    'Group totals fail reconciliation')
            groups[year + ':' + kind] = {'observations': len(selected), 'totals': totals, 'hourly': hourly, 'monthly': monthly}
    missing = expected_days * 24 - len(rows)
    metrics = {'schemaVersion': 1, 'caseId': BIKE, 'period': {'start': first, 'end': last},
               'source': {'title': 'UCI Bike Sharing / Capital Bikeshare, Washington D.C.',
                          'url': 'https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset', 'doi': '10.24432/C5W894'},
               'dataQuality': {'dailyRows': len(days), 'hourlyRows': len(rows), 'blankCells': 0,
                               'duplicateDailyDates': 0, 'duplicateHourlyKeys': 0, 'expectedCalendarHours': expected_days * 24,
                               'unrecordedHours': missing, 'imputedRows': 0, 'dailyHourlyReconciled': True},
               'definitions': {'hourlyMean': '分组计数之和 / 该组实际记录小时数；未记录小时不补零。',
                               'nonworking': 'workingday=0，包括周末或法定节假日，不等于仅周末。',
                               'total': '租借次数，不是去重人数。日表只作对账，不重复相加。'}, 'groups': groups}
    checks = [passed(f'真实解析日表{len(days)}行、小时表{len(rows)}行和ZIP内元数据'),
              passed('源表无空白，日期/小时和分组码合法，非负分项之和等于总计'),
              passed('自然日和小时键均无重复；日历完整，缺失小时不补零'),
              passed('每个自然日的三个小时计数分别与日表对账一致'),
              passed('9种年份/日期组合下，小时汇总、月份汇总与组总计一致')]
    return [(path, raw)], rows, metrics, checks


BIKE_JS = DOM + r'''
function bikeRender(){
 const group=DATA.groups[$('year').value+':'+$('daytype').value],audience=$('audience').value;
 const mean=h=>h.observations?h[audience]/h.observations:null;
 const observed=group.hourly.filter(h=>h.observations>0),peak=observed.reduce((a,b)=>mean(a)>=mean(b)?a:b);
 $('rental-total').textContent=fmt(group.totals[audience]);$('sample-count').textContent=fmt(group.observations);
 $('peak-hour').textContent=String(peak.hour).padStart(2,'0')+':00';$('peak-mean').textContent='峰值均值 '+fmt(mean(peak),1)+' 次 / 记录小时';
 $('selection-note').textContent=$('year').selectedOptions[0].textContent+' · '+$('daytype').selectedOptions[0].textContent+' · '+$('audience').selectedOptions[0].textContent+'：'+fmt(group.observations)+' 条小时记录；各小时均值按实际观测数计算，不把缺失当零。';
 const svg=$('hour-chart');svg.replaceChildren();svg.appendChild(svgNode('title',{},'0 至 23 点平均租借次数'));
 const width=970,height=288,left=52,right=20,top=25,bottom=45,ph=height-top-bottom,pw=width-left-right,max=Math.max(...observed.map(mean))*1.15;
 for(let i=0;i<=4;i++){const y=height-bottom-i*ph/4;svg.appendChild(svgNode('line',{x1:left,y1:y,x2:width-right,y2:y,class:'grid'}));svg.appendChild(svgNode('text',{x:left-9,y:y+4,'text-anchor':'end'},fmt(max*i/4)));}
 for(const h of group.hourly){const v=mean(h),x=left+h.hour*pw/24+4,w=pw/24-8,y=v===null?height-bottom:height-bottom-v/max*ph;
 const rect=svgNode('rect',{x,y,width:w,height:v===null?0:v/max*ph,rx:4,class:h.hour===peak.hour?'peak':''});rect.appendChild(svgNode('title',{},h.hour+':00；均值 '+fmt(v,1)+' 次；记录 '+h.observations+' 小时'));svg.appendChild(rect);
 if(h.hour%2===0)svg.appendChild(svgNode('text',{x:x+w/2,y:height-bottom+22,'text-anchor':'middle'},String(h.hour).padStart(2,'0')));}
 svg.appendChild(svgNode('text',{x:width-right,y:height-3,'text-anchor':'end'},'小时（当地时间，源数据口径）'));
 const tbody=$('hour-table');tbody.replaceChildren();
 for(const h of group.hourly){const tr=node('tr');cell(tr,String(h.hour).padStart(2,'0')+':00');cell(tr,fmt(h.observations));cell(tr,fmt(h[audience]));cell(tr,fmt(mean(h),2));tbody.appendChild(tr);}
 const chart=$('month-chart');chart.replaceChildren();chart.appendChild(svgNode('title',{},'各月租借总量'));
 const mm=Math.max(...group.monthly.map(m=>m[audience]))*1.15,mw=630,mh=240,ml=53,mb=48,mt=22,mpw=mw-ml-18,mph=mh-mb-mt;
 for(let i=0;i<=3;i++){const y=mh-mb-i*mph/3;chart.appendChild(svgNode('line',{x1:ml,y1:y,x2:mw-18,y2:y,class:'grid'}));chart.appendChild(svgNode('text',{x:ml-8,y:y+4,'text-anchor':'end'},fmt(mm*i/3/10000,1)+'万'));}
 for(const [i,m]of group.monthly.entries()){const x=ml+i*mpw/group.monthly.length+3,w=mpw/group.monthly.length-6,y=mh-mb-m[audience]/mm*mph,r=svgNode('rect',{x,y,width:w,height:mh-mb-y,rx:3});r.appendChild(svgNode('title',{},m.month+'：'+fmt(m[audience])+' 次；'+fmt(m.observations)+' 条记录'));chart.appendChild(r);if(i%3===0)chart.appendChild(svgNode('text',{x:x+w/2,y:mh-mb+22,'text-anchor':'middle'},m.month.slice(2)));}
}
for(const id of ['year','daytype','audience'])$(id).addEventListener('change',bikeRender);
bikeRender();
'''


def bike_artifacts(timestamp):
    inputs, rows, metrics, checks = read_bike()
    q = metrics['dataQuality']
    total = metrics['groups']['all:all']['totals']['total']
    peak = lambda kind: max(metrics['groups']['all:' + kind]['hourly'], key=lambda h: h['total'] / h['observations'])
    work, other = peak('working'), peak('nonworking')
    wm, om = work['total'] / work['observations'], other['total'] / other['observations']
    gaps = q['unrecordedHours']
    summary = f'把 {len(rows):,} 条真实小时记录变成可筛选的需求看板：工作日高峰 {work["hour"]}:00，非工作日 {other["hour"]}:00。'
    highlights = [
        {'title': '同一座城市，两种需求节奏', 'body': f'2011–2012年：工作日{work["hour"]}点均值{wm:.1f}次，非工作日{other["hour"]}点均值{om:.1f}次。可切换年份和用户类型自行比较。'},
        {'title': '让缺口也成为结果的一部分', 'body': f'源表少于日历应有小时数{gaps}条。未记录小时不补零，各小时均值采用实际观测数。'},
        {'title': '不是一张截图，是可复算成果', 'body': '小时、月份与总计逐项对账；CSV、JSON、报告与输入哈希一并公开。日表只用于核验，不重复累加。'},
    ]
    body = f'''
<section class="hero"><p class="eyebrow">01 / FROM RAW DATA TO A WORKING DASHBOARD</p><h1>{len(rows):,} 条骑行记录，<br>看见一座城市的<em>需求节奏。</em></h1><p class="lead">原始 CSV 不会自己讲故事。这里把逐小时记录，变成能按年份、工作日和用户类型探索的看板。先动手切一下：高峰会怎样变化？</p><div class="process"><span>读取公开 CSV</span><span>→ 逐日核对</span><span>→ 分组计算</span><span>→ 交互成果 + 可复算附件</span></div></section>
<section class="stats" aria-label="当前筛选指标"><div class="stat"><small>选中范围 · 租借总次数</small><strong id="rental-total">{total:,}</strong><span>不是去重人数，不是预测值</span></div><div class="stat"><small>纳入计算 · 小时记录</small><strong id="sample-count">{len(rows):,}</strong><span>未记录小时不补零</span></div><div class="stat"><small>平均需求最高时段</small><strong id="peak-hour">—</strong><span id="peak-mean">按实际观测小时计算</span></div></section>
<section class="panel"><div class="panel-head"><div><h2>把一天展开，需求就有了形状</h2><p class="hint">纵轴：每个记录小时的平均租借次数。悬停柱形看数值，也可展开完整数据表。</p></div><span class="tag">华盛顿 D.C. · 2011–2012</span></div><div class="filters"><label for="year">选择年份<select id="year"><option value="all">2011–2012 全部</option><option value="2011">2011 年</option><option value="2012">2012 年</option></select></label><label for="daytype">日期类型<select id="daytype"><option value="all">全部日期</option><option value="working">工作日</option><option value="nonworking">非工作日（周末 / 节假日）</option></select></label><label for="audience">用户类型<select id="audience"><option value="total">全部用户</option><option value="registered">注册用户</option><option value="casual">临时用户</option></select></label></div><p class="live" id="selection-note" aria-live="polite"></p><div class="chart-scroll"><svg id="hour-chart" class="chart" viewBox="0 0 970 288" role="img" aria-label="每小时平均租借次数柱状图"></svg></div><div class="legend"><span><i class="dot"></i>每小时均值</span><span><i class="dot" style="background:#5368cb"></i>当前峰值</span></div><details><summary>查看图表完整数据与分母</summary><div class="table-wrap"><table><caption>当前筛选 · 均值 = 租借次数 ÷ 实际记录数</caption><thead><tr><th scope="col">小时</th><th scope="col">记录数</th><th scope="col">租借次数</th><th scope="col">每记录小时均值</th></tr></thead><tbody id="hour-table"></tbody></table></div></details></section>
<div class="grid-two"><section class="panel"><h2>再退一步，看看月度全景</h2><p class="hint">同一筛选范围 · 每月租借总量。月份长度不同，不等同于日均水平。</p><div class="chart-scroll"><svg id="month-chart" class="chart" viewBox="0 0 630 240" role="img" aria-label="每月租借总量柱状图"></svg></div></section><section class="panel"><h2>数字之外，保留判断边界</h2><div class="note-list"><div class="note"><h3>不同日期，峰值不同</h3><p>两年整体工作日 {work['hour']} 点约 {wm:.1f} 次 / 记录小时，非工作日 {other['hour']} 点约 {om:.1f} 次。这是样本差异，不证明原因。</p></div><div class="note"><h3>没有记录，不等于没有需求</h3><p>{q['dailyRows']} 天应有 {q['expectedCalendarHours']:,} 个小时，实际 {len(rows):,} 条，少 {gaps} 条。不擅自补零，也不猜测缺口原因。</p></div><div class="note"><h3>要预测？那是下一项任务</h3><p>本成果没有训练模型，没有测算调度收益；需要另行定义目标、留出时段并评估。</p></div></div></section></div>
<section class="source"><h2>来源与复算</h2><p>来源：<a href="https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset" target="_blank" rel="noopener noreferrer">UCI Bike Sharing Dataset</a>，Capital Bikeshare；DOI 10.24432/C5W894。数据期 2011-01-01 至 2012-12-31。日表 {q['dailyRows']} 行、小时表 {len(rows):,} 行分别聚合相同活动，不可相加。</p><p>公开数据样例实作，不是客户项目或完整平台会话回放。生成时间与历史数据年份分开；本次离线复算不宣称源站实时更新。</p>{downloads()}</section>'''
    report = f'''# 从 {len(rows):,} 条骑行记录，到可探索的需求节奏

> 公开数据样例实作。成果生成：{timestamp}（UTC）；数据期：2011-01-01 至 2012-12-31。生成时间不是数据时间。本报告与旧 fieldReport 独立，不认证其模型分数、测试数或耗时。

## 原始任务与来源

把一份公开共享单车数据整理为能看懂、能筛选、能复算的需求看板。重点是分组规律、可追溯计算和诚实的缺失处理，不是预测模型。

来源：[UCI Bike Sharing Dataset](https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset)，DOI 10.24432/C5W894；美国华盛顿 D.C. Capital Bikeshare。

输入为 ../inputs/bike-sharing-dataset.zip；读取其中 Readme.txt、day.csv（{q['dailyRows']} 行）和 hour.csv（{len(rows):,} 行）。没有网络访问，也没有重新抓取源站。

## 可复核结果

| 指标 | 结果 | 口径 |
| --- | ---: | --- |
| 全期租借次数 | {total:,} | 小时表求和；日表只对账，不重复计入 |
| 2011 年租借次数 | {metrics['groups']['2011:all']['totals']['total']:,} | 源数据日历年 |
| 2012 年租借次数 | {metrics['groups']['2012:all']['totals']['total']:,} | 源数据日历年 |
| 工作日平均峰值 | {work['hour']}:00；{wm:.6f} 次 | 该时段 {work['observations']} 条实际记录 |
| 非工作日平均峰值 | {other['hour']}:00；{om:.6f} 次 | 该时段 {other['observations']} 条实际记录 |
| 未记录日历小时 | {gaps} | {q['expectedCalendarHours']:,} − {len(rows):,}；不补零 |

计数不是去重人数。workingday=0 含周末和节假日，不能简称为仅“周末”。样本分组差异不证明通勤、天气或运营动作造成差异。跨年总量还可能受未分析的供给规模变化影响，不构成业务增长或未来需求保证。

## 处理与公式

1. 严格解析全部记录；空白不会静默丢弃。日期、年月、小时、分组码及非负计数均验证。
2. 验证 casual + registered = cnt；自然日键、(date, hour) 键无重复。
3. 对每个自然日，将小时表三个计数分别求和，与日表逐项核对一致。
4. 年份（全部/2011/2012）×日期类型（全部/工作日/非工作日）共 9 个分组，各有小时桶和月度桶。
5. 小时均值 = 所选用户类型次数之和 ÷ 该组实际记录数。每小时分母在看板数据表可查看。
6. 月图展示租借总量，不是日均；各月天数和实际记录数不同。

derived.csv 保留全部 {len(rows):,} 条小时观测的日期、年份、月份、小时、工作日、天气码和三项计数。metrics.json 保留聚合分子与分母，不需要从图上反推四舍五入值。

## 缺失与实际检查

- 已记录字段空白为 0，重复日/小时键为 0；日表覆盖完整 {q['dailyRows']} 天。
- 未记录 {gaps} 个日历小时，不推断原因，不插补。
- 三项计数逐日对账一致；9 组的小时、月份和总计全部一致。
- manifest.json 记录输入与四项成果的 SHA-256、字节数及实际检查；不哈希 manifest 自身，避免循环。

只读复算命令：

    python3 packages/web-react/scripts/build-showcase-evidence.py --check

命令重新解析输入、重算内容，再比较 HTML、Markdown、CSV、JSON、manifest 的完整字节与哈希。它不是浏览器自动化测试，不代表旧案例的“34 项测试”。

## 交付与边界

[交互看板](dashboard.html) · [全部明细](derived.csv) · [聚合数据](metrics.json) · [来源核验](manifest.json)

没有训练模型，没有评估 R²、预测误差、真实用户耗时或经营收益。成果证明本次公开数据处理可查看、可复算，不证明平台端到端回放或客户项目效果。
'''
    outputs = {'dashboard.html': page('骑行需求探索看板', body, 'const DATA=' + inline(metrics) + ';\n' + BIKE_JS, timestamp),
               'report.md': report.encode(), 'metrics.json': jbytes(metrics),
               'derived.csv': csvbytes(rows, ['date', 'year', 'month', 'hour', 'workingday', 'weather', 'casual', 'registered', 'total'])}
    return bundle(BIKE, timestamp, summary,
                  [{'label': '真实小时记录', 'value': f'{len(rows):,}'}, {'label': '历史租借次数', 'value': f'{total:,}'},
                   {'label': '数据年份', 'value': '2011–2012'}], highlights, inputs, outputs, checks,
                  LIMITATIONS + [f'未记录{gaps}个日历小时；按实际观测求均值，不补零。', '日表只作对账，不重复计数；未训练或评估预测模型。'])


WB_FIELDS = {'population': ('SP.POP.TOTL', '人口', '人'), 'gdp': ('NY.GDP.PCAP.CD', '人均 GDP', '当年美元 / 人'),
             'internet': ('IT.NET.USER.ZS', '互联网使用率', '%')}
NAMES = {'IDN': '印度尼西亚', 'PHL': '菲律宾', 'VNM': '越南'}


def read_world():
    inputs, merged, metadata, count = [], {}, {}, 0
    for field, (indicator, label, unit) in WB_FIELDS.items():
        path = CASES / BRIEF / 'inputs' / ('world-bank-' + field + '.json')
        raw = path.read_bytes()
        inputs.append((path, raw))
        data = json.loads(raw)
        require(isinstance(data, list) and len(data) == 2 and isinstance(data[1], list), 'Invalid World Bank response')
        meta, records = data
        require(int(meta['pages']) == 1 and int(meta['page']) == 1 and int(meta['total']) == len(records), 'Incomplete pagination')
        metadata[field] = {'indicator': indicator, 'label': label, 'unit': unit, 'lastUpdated': meta['lastupdated'], 'records': len(records),
                           'url': f'https://api.worldbank.org/v2/country/IDN;PHL;VNM/indicator/{indicator}?date=2022&format=json&per_page=100'}
        seen = set()
        for r in records:
            require(r['indicator']['id'] == indicator, 'Wrong indicator')
            code, year, value = r['countryiso3code'], int(r['date']), r['value']
            require(code in NAMES and year == 2022, 'Country/year outside documented scope')
            require((code, year) not in seen, 'Duplicate country/year/indicator')
            seen.add((code, year))
            if value is not None:
                require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value), 'Non-finite observation')
                require(value >= 0 and (field != 'internet' or value <= 100), 'Out-of-range observation')
            row = merged.setdefault((code, year), {'country_code': code, 'country': NAMES[code], 'year': year})
            row[field] = value
            count += 1
    rows = []
    for key in sorted(merged):
        r = merged[key]
        for field in WB_FIELDS:
            r.setdefault(field, None)
        r['internet_users_estimate'] = r['population'] * r['internet'] / 100 if r['population'] is not None and r['internet'] is not None else None
        rows.append(r)
    require(len(rows) == 3 and count == 9, 'Expected 3 countries and 9 source observations')
    missing = sum(r[f] is None for r in rows for f in WB_FIELDS)
    estimates = [r for r in rows if r['internet_users_estimate'] is not None]
    pop = sum(r['population'] for r in rows if r['population'] is not None)
    est = sum(r['internet_users_estimate'] for r in estimates)
    denominator = sum(r['population'] for r in estimates)
    metrics = {'schemaVersion': 1, 'caseId': BRIEF, 'dataYear': 2022, 'source': 'World Bank World Development Indicators',
               'indicators': metadata, 'countries': rows,
               'summary': {'population': pop, 'internetUsersEstimate': est, 'estimateCountryCount': len(estimates),
                           'populationWeightedInternetRate': est / denominator * 100 if denominator else None},
               'dataQuality': {'sourceObservations': count, 'joinedCountryYearRows': len(rows), 'missingIndicatorCells': missing,
                               'completeCountryYearRows': sum(all(r[f] is not None for f in WB_FIELDS) for r in rows), 'duplicateKeys': 0, 'imputedCells': 0},
               'definitions': {'internetUsersEstimate': '人口×互联网使用率/100；派生近似量，不是独立官方统计或可触达客户数。',
                               'populationWeightedInternetRate': '人口与联网率均有效国家的估算联网人数之和 / 相同国家人口之和 ×100。',
                               'gdp': '当年美元口径，不是PPP、人均收入或个人可支配收入。',
                               'null': '缺失保留null，CSV为空；不插补、不按零值排名。'}}
    checks = [passed('真实解析3份JSON、9条观测；API分页记录数一致'), passed('指标ID、ISO3和2022年逐条验证，无重复键'),
              passed('按国家ISO3和年份连接，不依赖源文件行顺序'), passed(f'非空值范围合法；缺失{missing}项，不插补'),
              passed('人口×联网率派生估算和人口加权汇总使用同口径有效观测')]
    return inputs, rows, metrics, checks


WORLD_JS = DOM + r'''
const FIELDS={population:{label:'人口规模',unit:'万人',scale:10000,digits:1,tip:'人口不是客户数；仅比较三个样本国家，不是全东南亚排名。'},gdp:{label:'人均 GDP',unit:'美元 / 人',scale:1,digits:0,tip:'当年美元口径，不是购买力平价、个人收入或消费预算。'},internet:{label:'互联网使用率',unit:'%',scale:1,digits:2,tip:'互联网使用人口占比，不代表特定产品渗透率。'},internet_users_estimate:{label:'估算互联网使用人数',unit:'万人（估算）',scale:10000,digits:1,tip:'人口×联网率/100；派生近似量，不是独立官方统计，也不是可触达客户数。'}};
let selected='population';
function worldRender(){
 const field=FIELDS[selected],rows=[...DATA.countries];
 rows.sort($('sort').value==='value'?(a,b)=>(b[selected]??-Infinity)-(a[selected]??-Infinity):(a,b)=>a.country_code.localeCompare(b.country_code));
 const present=rows.filter(r=>r[selected]!==null),max=Math.max(...present.map(r=>r[selected]));
 $('metric-title').textContent=field.label+' · 2022';$('metric-note').textContent=field.tip;
 for(const b of document.querySelectorAll('[data-metric]'))b.setAttribute('aria-pressed',String(b.dataset.metric===selected));
 const bars=$('country-bars');bars.replaceChildren();
 for(const row of rows){const index=DATA.countries.findIndex(r=>r.country_code===row.country_code),value=row[selected],wrap=node('div',{class:'world-bar'});wrap.appendChild(node('span',{},row.country));const track=node('div',{class:'track','aria-hidden':'true'}),fill=node('div',{class:'fill'});fill.style.width=(value===null||max===0?0:value/max*100)+'%';fill.style.background=COLORS[index];track.appendChild(fill);wrap.appendChild(track);wrap.appendChild(node('span',{class:'bar-value'},value===null?'缺失':fmt(value/field.scale,field.digits)));bars.appendChild(wrap);}
 $('chart-unit').textContent='单位：'+field.unit+'；条形从0起，按当前指标最大值缩放。';
 const highest=present.length?present.reduce((a,b)=>a[selected]>=b[selected]?a:b):null;
 $('insight').textContent=highest?highest.country+' 在三个样本中'+field.label+'最高：'+fmt(highest[selected]/field.scale,field.digits)+' '+field.unit+'。换一个维度，比较结论也可能改变。':'当前指标没有有效数据；不排名。';
 const cards=$('country-cards');cards.replaceChildren();
 for(const [i,row]of DATA.countries.entries()){const card=node('article',{class:'country'});card.style.borderColor=COLORS[i];const intro=node('div');intro.appendChild(node('span',{class:'code'},row.country_code+' / '+row.year));intro.appendChild(node('h3',{},row.country));card.appendChild(intro);const value=node('div');value.appendChild(node('strong',{},row[selected]===null?'缺失':fmt(row[selected]/field.scale,field.digits)));value.appendChild(node('p',{},field.unit));card.appendChild(value);cards.appendChild(card);}
}
for(const b of document.querySelectorAll('[data-metric]'))b.addEventListener('click',()=>{selected=b.dataset.metric;worldRender();});
$('sort').addEventListener('change',worldRender);worldRender();
'''


def world_artifacts(timestamp):
    inputs, rows, metrics, checks = read_world()
    pop, est = metrics['summary']['population'], metrics['summary']['internetUsersEstimate']
    missing = metrics['dataQuality']['missingIndicatorCells']
    # Current fixed snapshot is complete; future missing inputs must not silently retain complete-sample prose.
    require(missing == 0, 'New snapshot has missing data; retain null values but revise narrative before publishing')
    best = {f: max(rows, key=lambda r: r[f]) for f in WB_FIELDS}
    fnum = lambda v, n=2: '缺失' if v is None else f'{v:,.{n}f}'
    links = '；'.join(f'<a href="{html.escape(m["url"], quote=True)}" target="_blank" rel="noopener noreferrer">{m["label"]}（{m["indicator"]}）</a>' for m in metrics['indicators'].values())
    table = ''.join('<tr>' + ''.join('<td>' + html.escape(str(v)) + '</td>' for v in
                     (r['country'], r['year'], fnum(r['population'], 0), fnum(r['gdp'], 2), fnum(r['internet'], 4), fnum(r['internet_users_estimate'], 0))) + '</tr>' for r in rows)
    highlights = [
        {'title': '不是搜几段资料，而是对齐三份原始数据', 'body': '人口、人均GDP、联网率按ISO3和2022年对齐：3国、9条观测，保留来源、单位与元数据更新时间。'},
        {'title': '换一个问题，换一种排序', 'body': '印度尼西亚的样本人口最大，越南的互联网使用率最高。按指标切换，不把不同尺度硬凑成总分。'},
        {'title': '算得出，也知道不能怎么用', 'body': '人口×联网率只是规模参考，不是产品客户数；人均GDP不等于个人收入，不给伪精确的“最佳市场”结论。'},
    ]
    body = f'''
<section class="hero"><p class="eyebrow">02 / THREE SOURCES, ONE CLEAR COMPARISON</p><h1>三个国家，三份数据。<br>从“我想了解”，到<em>一页看清。</em></h1><p class="lead">想初步比较印度尼西亚、菲律宾和越南，该先看规模，还是联网程度？这份简报把同一年、不同指标对齐。换个维度看，答案未必相同。</p><div class="process"><span>读取3份官方JSON</span><span>→ 国家与年份对齐</span><span>→ 计算并标注边界</span><span>→ 比较看板 + 简报</span></div></section>
<section class="stats" aria-label="数据概览"><div class="stat"><small>同年国家样本</small><strong>3 个</strong><span>印尼 · 菲律宾 · 越南</span></div><div class="stat"><small>原始官方指标观测</small><strong>9 条</strong><span>3国×3指标，缺失 {missing} 项</span></div><div class="stat"><small>数据年份，不是生成年份</small><strong>2022</strong><span>不混用不同年份作比较</span></div></section>
<section class="panel"><div class="panel-head"><div><h2>想比较什么？点击换一个视角</h2><p class="hint">展示真实值，不把人口、美元和比例拼成一个“综合得分”。</p></div><label class="hint" for="sort">排列方式 <select id="sort"><option value="value">当前指标从高到低</option><option value="code">国家代码顺序</option></select></label></div><div class="pillset" role="group" aria-label="比较指标"><button type="button" data-metric="population" aria-pressed="true">人口规模</button><button type="button" data-metric="gdp" aria-pressed="false">人均 GDP</button><button type="button" data-metric="internet" aria-pressed="false">互联网使用率</button><button type="button" data-metric="internet_users_estimate" aria-pressed="false">估算互联网使用人数</button></div><h3 id="metric-title">人口规模 · 2022</h3><p class="hint" id="metric-note"></p><div id="country-bars" aria-label="国家指标对比"></div><p class="hint" id="chart-unit"></p><p class="live" id="insight" aria-live="polite"></p></section>
<section class="countries" id="country-cards" aria-label="各国当前指标"></section>
<section class="panel" style="margin-top:20px"><h2>一页简报，不只给结论，也给依据</h2><div class="note-list"><div class="note"><h3>规模与覆盖率，回答不同问题</h3><p>印度尼西亚人口 {fnum(best['population']['population']/100000000)} 亿，样本规模最大；越南联网率 {fnum(best['internet']['internet'])}%，三个样本中最高。这不是同一种“领先”。</p></div><div class="note"><h3>允许估算，但明确它是估算</h3><p>将人口与联网率相乘，三个样本合计约 {fnum(est/100000000)} 亿联网人数（派生近似量）。这不是产品客户数，也不意味着可直接触达。</p></div><div class="note"><h3>把决策留给更完整的证据</h3><p>人均GDP使用当年美元，不是个人收入。市场进入决策还需要行业需求、法规、渠道、成本与实地验证。</p></div></div><details><summary>展开全部2022年对齐数据</summary><div class="table-wrap"><table><caption>原始精度保留于CSV/JSON，此表仅显示四舍五入。</caption><thead><tr><th scope="col">国家</th><th scope="col">年份</th><th scope="col">人口（人）</th><th scope="col">人均GDP（美元）</th><th scope="col">联网率（%）</th><th scope="col">估算联网人数</th></tr></thead><tbody>{table}</tbody></table></div></details></section>
<section class="source"><h2>官方来源，真实年份，清楚边界</h2><p>World Bank World Development Indicators；{links}。均为2022年观测，响应元数据 lastupdated=2026-07-13；它不是数据年份，也不是本次抓取时间。</p><p>按ISO3和年份连接，不依赖源文件行顺序。只比较3国，不是全东南亚排名或趋势。公开数据样例实作，不是客户项目或全程平台回放。</p>{downloads()}</section>'''
    markdown_rows = '\n'.join(f'| {r["country"]} | {r["year"]} | {fnum(r["population"], 0)} | {fnum(r["gdp"])} | {fnum(r["internet"], 4)} | {fnum(r["internet_users_estimate"], 0)} |' for r in rows)
    sources = '\n'.join(f'- {m["label"]}：{m["indicator"]}；单位 {m["unit"]}；[World Bank API]({m["url"]})；元数据 lastupdated={m["lastUpdated"]}。' for m in metrics['indicators'].values())
    report = f'''# 三份公开数据，一页三国比较简报

> 公开数据样例实作。成果生成：{timestamp}（UTC）；观测年份：2022；入库响应元数据 lastupdated：2026-07-13。三者不是同一概念。本报告独立于旧 fieldReport，不认证旧耗时或测试结果。

## 原始任务与交付

将印度尼西亚、菲律宾、越南的人口、人均GDP、互联网使用率整理为可比较、可追溯、可切换的看板，写出不超越证据边界的简报。

实际读取3份已入库World Bank JSON，共9条观测，按ISO3与年份连接为3行。没有网络访问，没有重新获取源站最新值。

## 同年对齐结果

| 国家 | 年份 | 人口（人） | 人均GDP（当年美元/人） | 联网率（%） | 估算联网人数（人） |
| --- | --- | ---: | ---: | ---: | ---: |
{markdown_rows}

原始精度保留在CSV/JSON。估算联网人数是人口×联网率/100的派生近似量，不是另一个官方原始指标。

## 三点观察

1. 规模不等于覆盖率。印度尼西亚样本人口最大，越南联网率最高；按问题选择指标，不把不同量纲强行合成得分。
2. 估算有用，但不能夸大。三个样本合计人口 {pop:,} 人，估算联网人数约 {est:,.0f} 人；这不是产品用户、可触达客户、付费意愿或市场收入。
3. 人均GDP不等于个人收入。这里是当年美元口径，不是购买力平价，不能直接等同居民消费预算，不能据此决定进入哪个国家。

## 数据源与单位

{sources}

## 处理、缺失与实际检查

- 验证JSON页数、总记录数、指标ID、ISO3和观测年份。
- 按(countryiso3code,year)连接，不依赖行顺序；重复键报错。
- 非空值为有限数；人口/GDP非负、联网率在0–100范围。
- 本次缺失 {missing} 个指标单元格；解析层保留null，CSV为空，不插补。若未来输入出现缺失，发布脚本会要求更新完整样本文案后再生成，不沿用当前完整样本结论。
- 估算联网人数=population*internet/100。人口加权联网率仅使用两项同时有效的国家，不是各国百分比简单平均。
- 本次只有2022年横截面，不声称时间趋势。看板按当前指标降序或ISO3顺序排列。
- manifest记录3个输入与4个产物SHA-256及字节数，不哈希manifest自身。

只读复算命令：

    python3 packages/web-react/scripts/build-showcase-evidence.py --check

重新读取源JSON，重算派生值和所有产物，核对完整字节与哈希。这不是平台端到端回放，也不核验旧案例耗时或测试数。

## 附件与边界

[比较看板](dashboard.html) · [对齐CSV](derived.csv) · [精确JSON](metrics.json) · [来源与校验](manifest.json)

如用于真实决策，还需行业需求、法规、支付/物流、竞争、获客成本等证据。不是全东南亚排名，不构成投资、市场进入或收益承诺，没有未经验证的“综合机会评分”。
'''
    outputs = {'dashboard.html': page('三国公开数据比较简报', body,
                                      'const DATA=' + inline(metrics) + ';\nconst COLORS=' + inline(COLORS) + ';\n' + WORLD_JS, timestamp),
               'report.md': report.encode(), 'metrics.json': jbytes(metrics),
               'derived.csv': csvbytes(rows, ['country_code', 'country', 'year', 'population', 'gdp', 'internet', 'internet_users_estimate'])}
    return bundle(BRIEF, timestamp, '把人口、人均GDP、联网率三份官方数据对齐为可交互比较：同年、同国、有原值，不做伪精确评分。',
                  [{'label': '对齐国家', 'value': '3'}, {'label': '原始观测', 'value': '9'}, {'label': '数据年份', 'value': '2022'}],
                  highlights, inputs, outputs, checks, LIMITATIONS + ['只有三个国家的2022年横截面，不代表全东南亚排名或趋势。',
                  '联网人数是人口×联网率派生估算，不是官方独立计数或客户规模。', '人均GDP为当年美元，不等于个人收入，不构成市场进入建议。'])


class Inspector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.links, self.scripts, self.csp, self.in_script = [], [], [], None, False

    def handle_starttag(self, tag, attrs_list):
        attrs = dict(attrs_list)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag == 'meta' and attrs.get('http-equiv', '').lower() == 'content-security-policy':
            self.csp = attrs.get('content')
        if tag == 'a':
            self.links.append(attrs.get('href', ''))
        require(not any(k.lower().startswith('on') for k in attrs), 'Inline event handler violates CSP')
        if tag in ('script', 'iframe', 'img', 'link', 'object', 'embed'):
            require('src' not in attrs and 'href' not in attrs and 'data' not in attrs, 'External/embedded resource not allowed')
        if tag == 'script':
            self.in_script = True
            self.scripts.append('')

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            self.scripts[-1] += data


def bundle(case_id, timestamp, summary, cards, highlights, inputs, outputs, checks, limitations):
    inspect = Inspector()
    inspect.feed(outputs['dashboard.html'].decode())
    require(len(inspect.ids) == len(set(inspect.ids)), 'Duplicate dashboard IDs')
    require(len(inspect.scripts) == 1, 'Expected one inline script')
    digest = base64.b64encode(hashlib.sha256(inspect.scripts[0].encode()).digest()).decode()
    require(inspect.csp and "default-src 'none'" in inspect.csp and "connect-src 'none'" in inspect.csp
            and f"script-src 'sha256-{digest}'" in inspect.csp, 'CSP hash mismatch')
    for href in inspect.links:
        require(href.startswith('https://') or href in {*outputs, 'manifest.json'}, 'Broken local/unsafe link: ' + href)
    checks += [passed('HTML无外部依赖，唯一内联脚本SHA-256与CSP一致'), passed('HTML所有本地产物链接存在，元素ID唯一')]
    outdir = CASES / case_id / 'showcase'
    manifest = {'schemaVersion': 1, 'caseId': case_id, 'generatedAt': timestamp, 'summary': summary, 'metrics': cards,
                'highlights': highlights, 'inputs': [file_record(path, data) for path, data in inputs],
                'outputs': [file_record(outdir / name, data) for name, data in outputs.items()],
                'checks': checks, 'limitations': limitations}
    outputs['manifest.json'] = jbytes(manifest)
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only input reparsing, full output recomputation and exact byte comparison')
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    for case_id, builder in [(BIKE, bike_artifacts), (BRIEF, world_artifacts)]:
        outdir = CASES / case_id / 'showcase'
        if args.check:
            timestamp = json.loads((outdir / 'manifest.json').read_bytes())['generatedAt']
            dt.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        else:
            timestamp = now
        expected = builder(timestamp)
        if not args.check:
            outdir.mkdir(parents=True, exist_ok=True)
        for name, data in expected.items():
            path = outdir / name
            if args.check:
                require(path.read_bytes() == data, case_id + '/' + name + ': bytes differ from recomputation')
            else:
                path.write_bytes(data)
        manifest = json.loads(expected['manifest.json'])
        require(all(c['passed'] for c in manifest['checks']), 'Failed check in manifest')
        print(f'{"CHECK PASS" if args.check else "BUILT"} {case_id}: {len(manifest["inputs"])} input hashes, '
              f'4 output hashes, {len(manifest["checks"])} actual checks; '
              f'{"5 files byte-identical to recomputation" if args.check else "5 artifacts written"}; generatedAt={timestamp}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        print('FAIL: ' + str(exc), file=sys.stderr)
        sys.exit(1)
