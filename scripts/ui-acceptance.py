"""V2 介面驗收（效能與版面）：手機 390×844（CPU 4× 降速）與桌面 1366×900，各跑一般與「減少動態效果」。
先 npm run build。需要 Python Playwright 與 Chrome（CHROME 指定路徑）。結果寫到 $OUT/perf.json 與截圖。
用法：python3 scripts/ui-acceptance.py"""
import subprocess, time, json, sys
from playwright.sync_api import sync_playwright
import os
OUT=os.environ.get('OUT','/tmp/ui-acceptance'); os.makedirs(OUT, exist_ok=True)
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME=os.environ.get('CHROME','/usr/bin/google-chrome')
PORT=8794
KEY='dice-baseball.club.v3'
srv=subprocess.Popen(['python3','-m','http.server',str(PORT),'-d',os.path.join(ROOT,'dist')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
URL=f'http://localhost:{PORT}/'
res={}
def kill(page): page.evaluate("document.querySelectorAll('.v2-modal-overlay').forEach(n=>n.remove())")
def ms(page, fn, sel, timeout=15000):
  t=time.perf_counter(); fn(); page.wait_for_selector(sel, timeout=timeout); return round((time.perf_counter()-t)*1000)
def rect(page, sel): return page.evaluate(f"(()=>{{const e=document.querySelector({json.dumps(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {{top:r.top,bottom:r.bottom,height:r.height,width:r.width}}}})()")
def long_tasks(page): return page.evaluate("window.__lt||[]")
LT_INIT="""window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({type:'longtask',buffered:true})}catch(e){}"""
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path=CHROME,args=['--no-sandbox'])
    # 1) 先做一份打過 3 小時、領過收益、招募過一次的存檔
    ctx=b.new_context(); page=ctx.new_page(); page.route('**/fonts.g*/**', lambda rt: rt.abort())
    page.clock.install(time=int(time.time()*1000)-4*3600*1000)
    page.goto(URL); page.wait_for_selector('.v2-create-btn'); page.fill('input','台北貓熊隊'); page.click('.v2-create-btn'); page.wait_for_selector('.v2-nav-btn')
    kill(page); page.clock.run_for(3*3600*1000); page.wait_for_timeout(2500); kill(page)
    page.click('.v2-claim'); page.wait_for_timeout(500)
    save=page.evaluate(f"localStorage.getItem('{KEY}')"); ctx.close()
    res['saveBytes']=len(save)
    for vname,vp,mobile,cpu in [('mobile',{'width':390,'height':844},True,4),('desktop',{'width':1366,'height':900},False,1)]:
     for reduced in [False, True]:
      key=vname+('-reduced' if reduced else '')
      r={}
      ctx=b.new_context(viewport=vp,is_mobile=mobile,has_touch=mobile,device_scale_factor=2 if mobile else 1,reduced_motion='reduce' if reduced else 'no-preference')
      ctx.add_init_script(f"localStorage.setItem('{KEY}', {json.dumps(save)});"+LT_INIT)
      page=ctx.new_page(); errs=[]; page.on('pageerror',lambda e: errs.append(str(e)))
      page.route('**/fonts.g*/**', lambda rt: rt.abort())
      cdp=ctx.new_cdp_session(page); cdp.send('Emulation.setCPUThrottlingRate',{'rate':cpu})
      t=time.perf_counter(); page.goto(URL); page.wait_for_selector('.v2-dashboard'); r['homeReadyMs']=round((time.perf_counter()-t)*1000)
      nav=page.evaluate("(()=>{const n=performance.getEntriesByType('navigation')[0];const f=performance.getEntriesByName('first-contentful-paint')[0];return {domContentLoaded:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),fcp:f?Math.round(f.startTime):null}})()")
      r.update(nav)
      page.wait_for_timeout(600); kill(page)
      page.screenshot(path=f'{OUT}/{key}-home.png')
      r['homeLiveDotAnimation']=page.evaluate("(()=>{const d=document.querySelector('[data-live-badge].live .v2-live-dot');return d?getComputedStyle(d).animationName:'(not live)'})()")
      r['homeHasLive']=page.is_visible('[data-live-card] .v2-live-row')
      # 首頁捲到底：最後一個按鈕不被底部導覽蓋住
      page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(200)
      navr=rect(page,'.v2-nav'); last=page.evaluate("(()=>{const bs=[...document.querySelectorAll('.v2-main button')];const b=bs[bs.length-1];const r=b.getBoundingClientRect();return {bottom:r.bottom,text:b.textContent.trim().slice(0,20)}})()")
      r['homeLastButtonClearOfNav']= (not mobile) or last['bottom'] <= navr['top']
      # 陣容：捲動流暢度（量 rAF 間隔）、捲到底不被導覽遮住
      r['lineupMs']=ms(page, lambda: page.click('[data-tab="lineup"]'), '.v2-lineup .v2-player')
      fps=page.evaluate("""new Promise(res=>{const gaps=[];let last=performance.now();let n=0;const H=document.body.scrollHeight;
        function f(t){gaps.push(t-last);last=t;window.scrollTo(0,(n/60)*H);n++;if(n<=60)requestAnimationFrame(f);else{gaps.shift();gaps.sort((a,b)=>a-b);res({p50:Math.round(gaps[Math.floor(gaps.length/2)]),p95:Math.round(gaps[Math.floor(gaps.length*0.95)]),max:Math.round(gaps[gaps.length-1])})}}requestAnimationFrame(f)})""")
      r['lineupScrollFrameMs']=fps
      page.wait_for_timeout(200)
      navr=rect(page,'.v2-nav'); dev=page.evaluate("(()=>{const d=[...document.querySelectorAll('.v2-develop')].pop().getBoundingClientRect();return d.bottom})()")
      r['lineupLastRowClearOfNav']=(not mobile) or dev<=navr['top']+0.5
      # 有未儲存草稿：儲存列浮在導覽上方、按鈕可以按
      page.evaluate("window.scrollTo(0,0)"); page.click('.v2-player >> nth=0'); page.click('.v2-player >> nth=9'); page.wait_for_timeout(300)
      sb=rect(page,'.v2-savebar.dirty'); navr=rect(page,'.v2-nav')
      r['savebarVisible']=sb is not None and sb['bottom']<=vp['height']
      r['savebarAboveNav']=(not mobile) or (sb is not None and sb['bottom']<=navr['top'])
      save_btn=rect(page,'[data-action="save-draft"]')
      r['saveButtonInViewport']=save_btn is not None and save_btn['bottom']<=vp['height'] and (not mobile or save_btn['bottom']<=navr['top'])
      page.screenshot(path=f'{OUT}/{key}-lineup-dirty.png')
      page.click('[data-action="reset-draft"]'); page.wait_for_timeout(200)
      # 球員養成面板
      r['playerSheetMs']=ms(page, lambda: page.click('.v2-develop >> nth=1'), '.v2-player-sheet .v2-upgrade-btn')
      page.wait_for_timeout(350)
      up=rect(page,'.v2-upgrade-btn'); r['upgradeButtonInViewport']=up['bottom']<=vp['height'] and up['top']>=0
      page.screenshot(path=f'{OUT}/{key}-player.png')
      page.keyboard.press('Escape'); page.wait_for_timeout(200)
      # 三選一招募
      r['recruitMs']=ms(page, lambda: (page.click('[data-action="recruit"]'), page.click('.v2-recruit-buttons [data-role="batter"]')), '.v2-cand')
      page.click('.v2-cand >> nth=0'); page.wait_for_timeout(350)
      cards=page.evaluate("[...document.querySelectorAll('.v2-cand')].map(c=>{const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}})")
      r['recruitCards']=cards
      conf=rect(page,'[data-action="recruit-confirm"]'); r['recruitConfirmInViewport']=conf['bottom']<=vp['height']
      page.screenshot(path=f'{OUT}/{key}-recruit.png')
      page.keyboard.press('Escape'); page.wait_for_timeout(200)
      # 直播 Canvas：開啟時間、畫布大小、有沒有畫東西、播放時的影格間隔
      page.click('[data-tab="home"]'); page.wait_for_timeout(300)
      r['liveOpenMs']=ms(page, lambda: page.click('[data-action="watch-live"]'), '.v2-replay-field canvas')
      page.wait_for_timeout(2500)
      cv=page.evaluate("""(()=>{const c=document.querySelector('.v2-replay-field canvas');const g=c.getContext('2d');const d=g.getImageData(0,0,c.width,c.height).data;let lit=0;for(let i=0;i<d.length;i+=400)if(d[i+3]>0)lit++;return {w:c.width,h:c.height,cssW:Math.round(c.getBoundingClientRect().width),cssH:Math.round(c.getBoundingClientRect().height),painted:lit>0}})()""")
      r['liveCanvas']=cv
      fr=page.evaluate("""new Promise(res=>{const gaps=[];let last=performance.now();function f(t){gaps.push(t-last);last=t;if(gaps.length<120)requestAnimationFrame(f);else{gaps.shift();gaps.sort((a,b)=>a-b);res({p50:Math.round(gaps[Math.floor(gaps.length/2)]),p95:Math.round(gaps[Math.floor(gaps.length*0.95)]),max:Math.round(gaps[gaps.length-1])})}}requestAnimationFrame(f)})""")
      r['liveFrameMs']=fr
      ctl=rect(page,'.v2-replay-toggle'); r['liveControlsInViewport']=ctl['bottom']<=vp['height']
      page.screenshot(path=f'{OUT}/{key}-live.png')
      # 減少動態效果：直播圓點、Toast、按鈕位移都不動
      r['replayReducedClass']=page.evaluate("document.querySelector('.v2-replay').classList.contains('reduced-motion')")
      r['replayFlashDisplay']=page.evaluate("getComputedStyle(document.querySelector('.v2-fx-flash')).display")
      page.click('[data-action="replay-back"]'); page.wait_for_timeout(300)
      r['longTasks']=long_tasks(page)
      r['errors']=errs
      res[key]=r
      ctx.close()
    # 打包大小
    import glob, gzip, os
    sizes={}
    for f in glob.glob(os.path.join(ROOT,'dist','assets','*')):
      raw=open(f,'rb').read(); sizes[os.path.basename(f)]={'raw':len(raw),'gzip':len(gzip.compress(raw,9))}
    res['bundle']=sizes
finally:
  srv.terminate()
json.dump(res,open(f'{OUT}/perf.json','w'),ensure_ascii=False,indent=1)
print(json.dumps(res,ensure_ascii=False,indent=1))
