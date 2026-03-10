
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Layers, ZoomIn, ZoomOut, Download, MoveHorizontal, MoveVertical, RefreshCcw, Settings, FileText } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";

(pdfjsLib as any).GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.js";

interface PdfHandle {
  file?: File;
  url?: string;
  doc?: any;
  numPages: number;
  pageImages: Record<number, HTMLCanvasElement>;
  pageImageData: Record<number, ImageData>;
  textCache: Record<number, string>;
}

type CompareMode = "side" | "overlay" | "diff";

const fileToObjectUrl = (file: File) => URL.createObjectURL(file);

async function loadPdf(file: File): Promise<PdfHandle> {
  const url = fileToObjectUrl(file);
  const loadingTask = (pdfjsLib as any).getDocument({ url });
  const doc = await loadingTask.promise;
  return { file, url, doc, numPages: doc.numPages, pageImages: {}, pageImageData: {}, textCache: {} };
}

async function renderPageToCanvas(doc: any, pageNumber: number, scale: number = 1.6): Promise<{ canvas: HTMLCanvasElement; imgData: ImageData }>{
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, imgData };
}

async function extractPageText(doc: any, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const text = (textContent.items as any[]).map((it) => it.str).join(" \n ");
  return text;
}

function computePixelDiff(a: ImageData, b: ImageData, options: { threshold?: number; noise?: number } = {}) {
  const { threshold = 12, noise = 0 } = options;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = w; diffCanvas.height = h;
  const dctx = diffCanvas.getContext("2d")!;
  const diffImage = dctx.createImageData(w, h);
  const ad = a.data, bd = b.data, dd = diffImage.data;
  for (let y=0;y<h;y++){
    for (let x=0;x<w;x++){
      const idx=(y*w+x)*4;
      const dr=Math.abs(ad[idx]-bd[idx]);
      const dg=Math.abs(ad[idx+1]-bd[idx+1]);
      const db=Math.abs(ad[idx+2]-bd[idx+2]);
      const delta=(dr+dg+db)/3;
      if(delta>threshold){
        // green for Eng-only, red for AS-only (simple brightness cue)
        const aL=(ad[idx]+ad[idx+1]+ad[idx+2])/3;
        const bL=(bd[idx]+bd[idx+1]+bd[idx+2])/3;
        if(aL>bL){ dd[idx]=60; dd[idx+1]=220; dd[idx+2]=90; dd[idx+3]=220; }
        else { dd[idx]=220; dd[idx+1]=60; dd[idx+2]=60; dd[idx+3]=220; }
      } else { dd[idx]=0; dd[idx+1]=0; dd[idx+2]=0; dd[idx+3]=0; }
    }
  }
  dctx.putImageData(diffImage,0,0);
  if(noise>0){
    const clean=dctx.getImageData(0,0,w,h); const cd=clean.data; const radius=Math.min(2,Math.max(0,Math.round(noise)));
    const getA=(x:number,y:number)=>cd[(y*w+x)*4+3]; const setA=(x:number,y:number,a:number)=>{const i=(y*w+x)*4; cd[i+3]=a};
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){ let opaque=0; for(let j=-radius;j<=radius;j++) for(let i=-radius;i<=radius;i++){ if(getA(x+i,y+j)>0) opaque++; }
      if(opaque<=1) setA(x,y,0);
    }
    dctx.putImageData(clean,0,0);
  }
  return { diffCanvas };
}

function drawOverlay(base: HTMLCanvasElement, top: HTMLCanvasElement, opts: { alpha?: number; dx?: number; dy?: number; colorizeTop?: string | null } = {}){
  const { alpha=0.5, dx=0, dy=0, colorizeTop="#00bcd4" } = opts;
  const w=Math.min(base.width, top.width), h=Math.min(base.height, top.height);
  const out=document.createElement('canvas'); out.width=w; out.height=h; const ctx=out.getContext('2d')!;
  ctx.drawImage(base,0,0); ctx.globalAlpha=alpha;
  if(colorizeTop){
    const temp=document.createElement('canvas'); temp.width=w; temp.height=h; const tctx=temp.getContext('2d')!;
    tctx.drawImage(top,dx,dy);
    const img=tctx.getImageData(0,0,w,h); const data=img.data;
    let rTint=0,gTint=188,bTint=212;
    for(let i=0;i<data.length;i+=4){ const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3]/255; data[i]=r*(1-0.7)+rTint*0.7; data[i+1]=g*(1-0.7)+gTint*0.7; data[i+2]=b*(1-0.7)+bTint*0.7; data[i+3]=Math.round(255*a); }
    tctx.putImageData(img,0,0); ctx.drawImage(temp,0,0);
  } else { ctx.drawImage(top,dx,dy); }
  ctx.globalAlpha=1; return out;
}

function usePanZoom(){
  const [zoom,setZoom]=useState(1); const [pan,setPan]=useState({x:0,y:0});
  const dragging=useRef(false); const last=useRef({x:0,y:0});
  const onWheel=useCallback((e: React.WheelEvent)=>{ e.preventDefault(); const delta=e.deltaY<0?0.1:-0.1; setZoom(z=>Math.max(0.2, Math.min(6, z+delta))); },[]);
  const onMouseDown=useCallback((e: React.MouseEvent)=>{dragging.current=true; last.current={x:e.clientX,y:e.clientY};},[]);
  const onMouseMove=useCallback((e: React.MouseEvent)=>{ if(!dragging.current) return; const dx=e.clientX-last.current.x; const dy=e.clientY-last.current.y; last.current={x:e.clientX,y:e.clientY}; setPan(p=>({x:p.x+dx,y:p.y+dy})); },[]);
  const onMouseUp=useCallback(()=>{dragging.current=false;},[]);
  const reset=useCallback(()=>{ setZoom(1); setPan({x:0,y:0}); },[]);
  return { zoom, pan, setZoom, setPan, onWheel, onMouseDown, onMouseMove, onMouseUp, reset };
}

function CanvasViewport({ canvas, label, zoom, pan, onWheel, onMouseDown, onMouseMove, onMouseUp }:{ canvas?: HTMLCanvasElement; label?: string; zoom: number; pan:{x:number;y:number}; onWheel:(e:React.WheelEvent)=>void; onMouseDown:(e:React.MouseEvent)=>void; onMouseMove:(e:React.MouseEvent)=>void; onMouseUp:(e:React.MouseEvent)=>void; }){
  const [dataUrl,setDataUrl]=useState<string|null>(null);
  useEffect(()=>{ if(!canvas) return; setDataUrl(canvas.toDataURL('image/png')); },[canvas]);
  return (
    <div className="canvas-wrap" onWheel={onWheel}>
      <div className="canvas-inner" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
        <div className="center" style={{ transform:`translate(-50%,-50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {dataUrl? <img src={dataUrl} alt={label||'canvas'} draggable={false} /> : <div className="small" style={{color:'#9ca3af'}}>No image</div>}
        </div>
      </div>
      {label && <div style={{position:'absolute',top:12,left:12}}><span className="badge">{label}</span></div>}
    </div>
  )
}

function KeyValue({k,v}:{k:string; v?:string}){ return <div className="kv"><span className="k">{k}</span><span>{v||'—'}</span></div> }

function parseIsometricMeta(text: string){
  const kv=(regexes: RegExp[])=>{ for(const r of regexes){ const m=text.match(r); if(m) return (m[m.length-1]||'').trim(); } return undefined; };
  return {
    lineNo: kv([/Line\s*No\s*[:\-]?\s*([A-Z0-9\-\/_\.]+)/i, /Line\s*Number\s*[:\-]?\s*([A-Z0-9\-\/_\.]+)/i]),
    revision: kv([/Rev(?:ision)?\s*[:\-]?\s*([A-Z0-9\.]+)/i]),
    spec: kv([/Spec(?:ification)?\s*[:\-]?\s*([A-Z0-9\-]+)/i]),
    size: kv([/Size\s*[:\-]?\s*([0-9\.]+\s*(?:NB|NPS|MM|IN)?)/i, /(\d+\s*(?:NB|NPS|MM|IN)?)\s*SIZE/i]),
    service: kv([/Service\s*[:\-]?\s*([A-Z0-9 \-]+)/i]),
    insulation: kv([/Insulat(?:ion)?\s*[:\-]?\s*([^\n\r]+)/i]),
    testPressure: kv([/(?:Hydro(?:\s*Test)?\s*Pressure|Test\s*Pressure)\s*[:\-]?\s*([0-9\.]+\s*(?:kg\/cm2|bar|psi)?)/i]),
  }
}

export default function IsoCompareApp(){
  const [eng,setEng]=useState<PdfHandle|null>(null);
  const [autoSpool,setAutoSpool]=useState<PdfHandle|null>(null);
  const [engPage,setEngPage]=useState(1); const [asPage,setAsPage]=useState(1);
  const [mode,setMode]=useState<CompareMode>('side');
  const [overlayAlpha,setOverlayAlpha]=useState(0.5); const [diffThreshold,setDiffThreshold]=useState(12); const [diffNoise,setDiffNoise]=useState(1);
  const [colorizeTop,setColorizeTop]=useState(true);
  const [alignDx,setAlignDx]=useState(0); const [alignDy,setAlignDy]=useState(0);
  const panLeft=usePanZoom(); const panRight=usePanZoom(); const panSingle=usePanZoom(); const [sync,setSync]=useState(true);
  const overlayCanvas=useRef<HTMLCanvasElement|null>(null); const diffCanvas=useRef<HTMLCanvasElement|null>(null);
  const [engMeta,setEngMeta]=useState<any>({}); const [asMeta,setAsMeta]=useState<any>({}); const [busy,setBusy]=useState(false);

  const handleFile=async(file: File, type:'eng'|'as')=>{ setBusy(true); try{ const pdf=await loadPdf(file); if(type==='eng'){ setEng(pdf); setEngPage(1);} else { setAutoSpool(pdf); setAsPage(1);} } catch(e){ console.error(e); alert('Failed to load PDF.'); } finally{ setBusy(false);} };

  const ensureRendered=useCallback(async(handle: PdfHandle|null, pageNo:number)=>{
    if(!handle||!handle.doc) return; if(!handle.pageImages[pageNo]){ const {canvas,imgData}=await renderPageToCanvas(handle.doc,pageNo,1.6); handle.pageImages[pageNo]=canvas; handle.pageImageData[pageNo]=imgData; }
  },[]);

  const ensureText=useCallback(async(handle: PdfHandle|null, pageNo:number, setMeta:(m:any)=>void)=>{
    if(!handle||!handle.doc) return; if(!handle.textCache[pageNo]){ const tx=await extractPageText(handle.doc,pageNo); handle.textCache[pageNo]=tx; } const meta=parseIsometricMeta(handle.textCache[pageNo]); setMeta(meta);
  },[]);

  const buildOverlay=useCallback(()=>{
    if(!eng||!autoSpool) return; const e=eng.pageImages[engPage]; const a=autoSpool.pageImages[asPage]; if(!e||!a) return; overlayCanvas.current = drawOverlay(e,a,{alpha:overlayAlpha,dx:alignDx,dy:alignDy,colorizeTop:colorizeTop?'#00bcd4':null});
  },[eng,autoSpool,engPage,asPage,overlayAlpha,alignDx,alignDy,colorizeTop]);

  const buildDiff=useCallback(()=>{
    if(!eng||!autoSpool) return; const e=eng.pageImageData[engPage]; const a=autoSpool.pageImageData[asPage]; if(!e||!a) return; const shift=(img:ImageData,dx:number,dy:number)=>{ const w=img.width,h=img.height; const c=document.createElement('canvas'); c.width=w;c.height=h; const ctx=c.getContext('2d')!; const tmp=document.createElement('canvas'); tmp.width=w; tmp.height=h; const tctx=tmp.getContext('2d')!; tctx.putImageData(img,0,0); ctx.drawImage(tmp,dx,dy); return ctx.getImageData(0,0,w,h); };
    const aShifted=(alignDx!==0||alignDy!==0)?shift(a,alignDx,alignDy):a; const { diffCanvas:dc }=computePixelDiff(e,aShifted,{threshold:diffThreshold,noise:diffNoise}); diffCanvas.current=dc;
  },[eng,autoSpool,engPage,asPage,alignDx,alignDy,diffThreshold,diffNoise]);

  useEffect(()=>{ (async()=>{ await ensureRendered(eng,engPage); await ensureRendered(autoSpool,asPage); await ensureText(eng,engPage,setEngMeta); await ensureText(autoSpool,asPage,setAsMeta); buildOverlay(); buildDiff(); })(); },[eng,autoSpool,engPage,asPage,ensureRendered,ensureText,buildOverlay,buildDiff]);

  useEffect(()=>{ if(!sync) return; panRight.setZoom(panLeft.zoom); panRight.setPan(panLeft.pan); },[sync, panLeft.zoom, panLeft.pan]);

  const totalDiffPixels = useMemo(()=>{ if(!diffCanvas.current) return 0; const ctx=diffCanvas.current.getContext('2d')!; const img=ctx.getImageData(0,0,diffCanvas.current.width,diffCanvas.current.height); let c=0; for(let i=3;i<img.data.length;i+=4) if(img.data[i]>0) c++; return c; },[diffCanvas.current, diffThreshold, diffNoise, engPage, asPage]);

  const engPages=Array.from({length: eng?.numPages||0}, (_,i)=>i+1);
  const asPages=Array.from({length: autoSpool?.numPages||0}, (_,i)=>i+1);

  const downloadPNG=(canvas: HTMLCanvasElement|null, filename: string)=>{ if(!canvas) return; const a=document.createElement('a'); a.download=filename; a.href=canvas.toDataURL('image/png'); a.click(); };

  return (
    <div style={{display:'grid', gap:12}}>
      <div className="flex-spread">
        <div>
          <div className="h1">Isometric PDF Compare</div>
          <div className="muted">Compare Engineering vs AutoSpool drawings (Side-by-side, Overlay, Pixel Diff). Runs entirely in your browser.</div>
        </div>
        <button className="btn" onClick={()=>{ panLeft.reset(); panRight.reset(); panSingle.reset(); }}><RefreshCcw size={16}/> Reset View</button>
      </div>

      <div className="card">
        <div className="card-h">Upload PDFs</div>
        <div className="card-c">
          <div className="grid2">
            <div>
              <div className="label"><Upload size={16}/> Engineering PDF</div>
              <input className="input" type="file" accept="application/pdf" onChange={e=>{ const f=e.target.files?.[0]; if(f) handleFile(f,'eng'); }} />
              {eng?.file && <div className="small muted" style={{marginTop:6}}>Loaded: {eng.file.name} ({eng.numPages} pages)</div>}
            </div>
            <div>
              <div className="label"><Upload size={16}/> AutoSpool PDF</div>
              <input className="input" type="file" accept="application/pdf" onChange={e=>{ const f=e.target.files?.[0]; if(f) handleFile(f,'as'); }} />
              {autoSpool?.file && <div className="small muted" style={{marginTop:6}}>Loaded: {autoSpool.file.name} ({autoSpool.numPages} pages)</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="row">
        <div className="card">
          <div className="card-h">Viewer</div>
          <div className="card-c" style={{display:'grid', gap:8}}>
            <div className="flex" style={{flexWrap:'wrap', gap:8}}>
              <label className="label">Mode:</label>
              <select className="select" value={mode} onChange={e=>setMode(e.target.value as CompareMode)}>
                <option value="side">Side-by-Side</option>
                <option value="overlay">Overlay</option>
                <option value="diff">Diff</option>
              </select>
            </div>

            {mode==='side' && (
              <div className="grid2">
                <div>
                  <div className="flex-spread">
                    <div className="flex"><FileText size={16}/> <span className="small">Engineering Page</span></div>
                    <div className="flex">
                      <select className="select" value={String(engPage)} onChange={e=>setEngPage(parseInt(e.target.value))}>
                        {engPages.map(p=> <option key={p} value={p}>Page {p}</option>)}
                      </select>
                      <ZoomOut size={16}/>
                      <input className="range" type="range" min={0.2} max={6} step={0.1} value={panLeft.zoom} onChange={e=>panLeft.setZoom(parseFloat(e.target.value))}/>
                      <ZoomIn size={16}/>
                    </div>
                  </div>
                  <CanvasViewport canvas={eng?.pageImages[engPage]} label="Engineering" zoom={panLeft.zoom} pan={panLeft.pan} onWheel={panLeft.onWheel} onMouseDown={panLeft.onMouseDown} onMouseMove={panLeft.onMouseMove} onMouseUp={panLeft.onMouseUp} />
                </div>
                <div>
                  <div className="flex-spread">
                    <div className="flex"><FileText size={16}/> <span className="small">AutoSpool Page</span></div>
                    <div className="flex">
                      <select className="select" value={String(asPage)} onChange={e=>setAsPage(parseInt(e.target.value))}>
                        {asPages.map(p=> <option key={p} value={p}>Page {p}</option>)}
                      </select>
                      <ZoomOut size={16}/>
                      <input className="range" type="range" min={0.2} max={6} step={0.1} value={sync?panLeft.zoom:panRight.zoom} onChange={e=> (sync? panLeft.setZoom(parseFloat(e.target.value)):panRight.setZoom(parseFloat(e.target.value)))} />
                      <ZoomIn size={16}/>
                    </div>
                  </div>
                  <CanvasViewport canvas={autoSpool?.pageImages[asPage]} label="AutoSpool" zoom={sync?panLeft.zoom:panRight.zoom} pan={sync?panLeft.pan:panRight.pan} onWheel={sync?panLeft.onWheel:panRight.onWheel} onMouseDown={sync?panLeft.onMouseDown:panRight.onMouseDown} onMouseMove={sync?panLeft.onMouseMove:panRight.onMouseMove} onMouseUp={sync?panLeft.onMouseUp:panRight.onMouseUp} />
                </div>
              </div>
            )}

            {mode==='overlay' && (
              <div style={{display:'grid', gap:8}}>
                <div className="flex" style={{flexWrap:'wrap'}}>
                  <label className="label"><Layers size={16}/> Overlay Alpha</label>
                  <input className="range" type="range" min={0} max={1} step={0.05} value={overlayAlpha} onChange={e=>setOverlayAlpha(parseFloat(e.target.value))}/>
                  <span className="small" style={{color:'#4b5563'}}>{Math.round(overlayAlpha*100)}%</span>
                  <label className="small" style={{marginLeft:12}}><input type="checkbox" checked={colorizeTop} onChange={e=>setColorizeTop(e.target.checked)} /> Colorize AutoSpool layer</label>
                </div>
                <div className="grid2">
                  <div className="flex"><MoveHorizontal size={16}/> <span className="small">Align X</span></div>
                  <div className="flex"><input className="range" type="range" min={-200} max={200} step={1} value={alignDx} onChange={e=>setAlignDx(parseInt(e.target.value))}/> <input className="input" type="number" value={alignDx} onChange={e=>setAlignDx(parseInt(e.target.value||'0'))}/></div>
                  <div className="flex"><MoveVertical size={16}/> <span className="small">Align Y</span></div>
                  <div className="flex"><input className="range" type="range" min={-200} max={200} step={1} value={alignDy} onChange={e=>setAlignDy(parseInt(e.target.value))}/> <input className="input" type="number" value={alignDy} onChange={e=>setAlignDy(parseInt(e.target.value||'0'))}/></div>
                </div>
                <div className="flex">
                  <button className="btn" onClick={()=>{setAlignDx(0); setAlignDy(0)}}><RefreshCcw size={16}/> Reset Alignment</button>
                  <div style={{marginLeft:'auto'}} className="flex"><ZoomOut size={16}/><input className="range" type="range" min={0.2} max={6} step={0.1} value={panSingle.zoom} onChange={e=>panSingle.setZoom(parseFloat(e.target.value))}/><ZoomIn size={16}/></div>
                </div>
                <CanvasViewport canvas={overlayCanvas.current||undefined} label="Overlay (Engineering base + AutoSpool on top)" zoom={panSingle.zoom} pan={panSingle.pan} onWheel={panSingle.onWheel} onMouseDown={panSingle.onMouseDown} onMouseMove={panSingle.onMouseMove} onMouseUp={panSingle.onMouseUp} />
                <div style={{display:'flex', justifyContent:'flex-end'}}>
                  <button className="btn" onClick={()=>downloadPNG(overlayCanvas.current, `overlay_p${engPage}_${asPage}.png`)}><Download size={16}/> Download Overlay PNG</button>
                </div>
              </div>
            )}

            {mode==='diff' && (
              <div style={{display:'grid', gap:8}}>
                <div className="grid2">
                  <div className="flex"><Settings size={16}/> <span className="small">Threshold</span></div>
                  <div className="flex"><input className="range" type="range" min={0} max={64} step={1} value={diffThreshold} onChange={e=>setDiffThreshold(parseInt(e.target.value))}/> <span className="small" style={{width:40,textAlign:'right',color:'#4b5563'}}>{diffThreshold}</span></div>
                  <div className="flex"><span className="small">Noise Cleanup</span></div>
                  <div className="flex"><input className="range" type="range" min={0} max={3} step={1} value={diffNoise} onChange={e=>setDiffNoise(parseInt(e.target.value))}/> <span className="small" style={{width:40,textAlign:'right',color:'#4b5563'}}>{diffNoise}</span></div>
                  <div className="flex"><span className="small">Alignment DX</span></div>
                  <div className="flex"><input className="range" type="range" min={-200} max={200} step={1} value={alignDx} onChange={e=>setAlignDx(parseInt(e.target.value))}/> <span className="small" style={{width:40,textAlign:'right',color:'#4b5563'}}>{alignDx}</span></div>
                  <div className="flex"><span className="small">Alignment DY</span></div>
                  <div className="flex"><input className="range" type="range" min={-200} max={200} step={1} value={alignDy} onChange={e=>setAlignDy(parseInt(e.target.value))}/> <span className="small" style={{width:40,textAlign:'right',color:'#4b5563'}}>{alignDy}</span></div>
                </div>
                <div className="small" style={{color:'#4b5563'}}>Changed pixels: <strong style={{color:'#111827'}}>{totalDiffPixels.toLocaleString()}</strong></div>
                <CanvasViewport canvas={diffCanvas.current||undefined} label="Pixel Diff (Green: only in Engineering, Red: only in AutoSpool)" zoom={panSingle.zoom} pan={panSingle.pan} onWheel={panSingle.onWheel} onMouseDown={panSingle.onMouseDown} onMouseMove={panSingle.onMouseMove} onMouseUp={panSingle.onMouseUp} />
                <div style={{display:'flex', justifyContent:'flex-end'}}>
                  <button className="btn" onClick={()=>downloadPNG(diffCanvas.current, `diff_p${engPage}_${asPage}.png`)}><Download size={16}/> Download Diff PNG</button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{display:'grid', gap:12}}>
          <div className="card">
            <div className="card-h">Pages & View</div>
            <div className="card-c" style={{display:'grid', gap:8}}>
              <div className="flex-spread small"><span>Sync Pan/Zoom</span><label className="small"><input type="checkbox" checked={sync} onChange={e=>setSync(e.target.checked)} /> Sync</label></div>
              <div className="grid2">
                <div className="small" style={{color:'#4b5563'}}>Engineering Page</div>
                <select className="select" value={String(engPage)} onChange={e=>setEngPage(parseInt(e.target.value))}>{engPages.map(p=><option key={p} value={p}>Page {p}</option>)}</select>
                <div className="small" style={{color:'#4b5563'}}>AutoSpool Page</div>
                <select className="select" value={String(asPage)} onChange={e=>setAsPage(parseInt(e.target.value))}>{asPages.map(p=><option key={p} value={p}>Page {p}</option>)}</select>
              </div>
              <div style={{borderTop:'1px solid #e5e7eb', paddingTop:8}}>
                <div className="flex small" style={{marginBottom:6}}><Settings size={16}/> <span>Zoom (Shared)</span></div>
                <div className="flex"><ZoomOut size={16}/><input className="range" type="range" min={0.2} max={6} step={0.1} value={panSingle.zoom} onChange={e=>{ const v=parseFloat(e.target.value); panSingle.setZoom(v); panLeft.setZoom(v); panRight.setZoom(v); }}/><ZoomIn size={16}/></div>
              </div>
              <div className="tip">Tip: Drag in the viewer to pan. Use trackpad or mouse wheel to zoom.</div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">Extracted Metadata (heuristic)</div>
            <div className="card-c">
              <div className="grid2">
                <div>
                  <div style={{fontWeight:600, marginBottom:6}}>Engineering</div>
                  <KeyValue k="Line No" v={engMeta.lineNo} />
                  <KeyValue k="Revision" v={engMeta.revision} />
                  <KeyValue k="Spec" v={engMeta.spec} />
                  <KeyValue k="Size" v={engMeta.size} />
                  <KeyValue k="Service" v={engMeta.service} />
                  <KeyValue k="Insulation" v={engMeta.insulation} />
                  <KeyValue k="Test Pressure" v={engMeta.testPressure} />
                </div>
                <div>
                  <div style={{fontWeight:600, marginBottom:6}}>AutoSpool</div>
                  <KeyValue k="Line No" v={asMeta.lineNo} />
                  <KeyValue k="Revision" v={asMeta.revision} />
                  <KeyValue k="Spec" v={asMeta.spec} />
                  <KeyValue k="Size" v={asMeta.size} />
                  <KeyValue k="Service" v={asMeta.service} />
                  <KeyValue k="Insulation" v={asMeta.insulation} />
                  <KeyValue k="Test Pressure" v={asMeta.testPressure} />
                </div>
              </div>
              <div className="small" style={{marginTop:8,color:'#6b7280'}}>
                Note: Metadata extraction is heuristic. For robust results, configure field anchors or calibrate using sample title blocks.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">Exports</div>
            <div className="card-c" style={{display:'grid', gap:8}}>
              <button className="btn" onClick={()=>{
                const c = mode==='diff'? diffCanvas.current : overlayCanvas.current;
                if(!c) { alert('Nothing to export yet. Load PDFs and render the view.'); return; }
                const fname = mode==='diff'? `diff_p${engPage}_${asPage}.png` : `overlay_p${engPage}_${asPage}.png`;
                const a=document.createElement('a'); a.download=fname; a.href=c.toDataURL('image/png'); a.click();
              }}><Download size={16}/> Download Current View PNG</button>
              <div className="tip">Roadmap: Export change report (PDF/Excel) with metadata delta, weld count changes, and marked snapshots.</div>
            </div>
          </div>
        </div>
      </div>

      {busy && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.1)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:50}}>
          <div style={{background:'#fff',borderRadius:12,boxShadow:'0 8px 24px rgba(0,0,0,0.1)',padding:'10px 14px',fontSize:14}}>Processing…</div>
        </div>
      )}

      <div className="small muted">Privacy: Files are processed locally in your browser; no upload occurs in this prototype.</div>
    </div>
  )
}
