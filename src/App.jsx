import { useState, useEffect, useCallback, useRef } from "react";

const STAT_TYPES = ["Points","Rebounds","Assists","3-Pointers","Blocks","Steals","PRA","PR","PA","RA"];
const SIM_PRESETS = [1000,5000,10000,25000,50000];
const DEFAULT_ITERS = 10000;



// ═══════════════════════════════════════════════════════════════
// MODEL ENHANCEMENT CONSTANTS
// ═══════════════════════════════════════════════════════════════

// Stat-type volatility multipliers (applied to SD, not mean)
const STAT_VOL_MULT = {
  "Points":     1.00,
  "Rebounds":   0.95,
  "Assists":    1.08,
  "3-Pointers": 1.18,
  "Blocks":     1.25,
  "Steals":     1.25,
  "PRA":        0.92,
  "PR":         0.95,
  "PA":         1.00,
  "RA":         1.02,
};

// League-average opponent allowed per-minute for each stat type
// (per-48 typical league avg: Points ~107/48, Reb ~44/48, etc.)
const LEAGUE_AVG_ALLOWED_RATE = {
  "Points":     107 / 48,
  "Rebounds":   44  / 48,
  "Assists":    25  / 48,
  "3-Pointers": 12  / 48,
  "Blocks":     5   / 48,
  "Steals":     8   / 48,
  "PRA":        176 / 48,
  "PR":         151 / 48,
  "PA":         132 / 48,
  "RA":         69  / 48,
};

// Clamp helper
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

// ─── Matchup factors from opponent allowed rate ───────────────
// oppAllowed:      weighted opponent allowed total (e.g. pts allowed L5)
// leagueAvgAllowed: user-supplied league average for the same window/position
//   If leagueAvgAllowed is 0/missing, ratio = 1 (neutral)
function computeMatchupFactors(oppAllowed, leagueAvgAllowed){
  if(!oppAllowed || oppAllowed <= 0) return { matchupMeanFactor:1, matchupVarFactor:1, cappedRatio:1, oppRate:null, leagueAvgRate:null };
  // Values are per-game averages (from Google Sheet or manual entry)
  const oppRate     = oppAllowed;
  const leagueRate  = leagueAvgAllowed > 0 ? leagueAvgAllowed : oppRate; // neutral if no league avg
  const matchupRatio  = leagueRate > 0 ? oppRate / leagueRate : 1;
  const cappedRatio   = clamp(matchupRatio, 0.88, 1.12);
  const matchupMeanFactor = 1 + (cappedRatio - 1) * 0.40;
  const matchupVarFactor  = 1 + (cappedRatio - 1) * 0.70;
  return { matchupMeanFactor, matchupVarFactor, cappedRatio:+cappedRatio.toFixed(3), oppRate:+oppRate.toFixed(4), leagueAvgRate:+leagueRate.toFixed(4) };
}

// ─── Minutes stability ────────────────────────────────────────
function computeMinuteStability(sdMin, meanMin){
  const minuteCV = meanMin > 0 ? sdMin / meanMin : 0.2;
  return clamp(1 - minuteCV * 1.2, 0, 1);
}

// ─── Shrinkage blend ─────────────────────────────────────────
// Blends recent rate toward season mean when SD is high (low confidence)
// recentRate: recency-weighted mean rate
// seasonRate: unweighted mean rate (longer-term anchor)
// sdRate: current SD (higher SD → more shrinkage)
// meanRate: scale reference
function applyShrinkage(recentRate, seasonRate, sdRate, meanRate){
  const cv = meanRate > 0 ? sdRate / meanRate : 0.3;
  // shrink factor: 0 = trust recent fully, 1 = full regression to season
  // CV of 0.3+ = moderate shrinkage, CV of 0.6+ = strong shrinkage
  const shrinkFactor = clamp(cv * 1.2, 0, 0.45);
  return recentRate * (1 - shrinkFactor) + seasonRate * shrinkFactor;
}

// ─── Boom / Bust metrics ──────────────────────────────────────
function computeBoomBust(outcomes, propLine){
  if(!outcomes||!outcomes.length||!propLine) return null;
  const n = outcomes.length;
  const boomLine = propLine * 1.25;
  const bustLine = propLine * 0.80;
  const boomCount = outcomes.filter(v=>v >= boomLine).length;
  const bustCount = outcomes.filter(v=>v <= bustLine).length;
  return {
    boomPct:  +smoothPct(boomCount, n).toFixed(1),
    bustPct:  +smoothPct(bustCount, n).toFixed(1),
    boomLine: +boomLine.toFixed(1),
    bustLine: +bustLine.toFixed(1),
  };
}

// ─── Ceiling Score (0–100) ────────────────────────────────────
function computeCeilingScore({ boomPct, p90, propLine, matchupVarFactor, sdRate, meanRate, minuteStability }){
  if(!propLine) return 50;
  const p90ratio   = propLine > 0 ? clamp((p90 - propLine) / propLine, -0.5, 1.0) : 0;
  const boomNorm   = clamp(boomPct / 100, 0, 1);
  const varBonus   = clamp((matchupVarFactor - 1) * 3, -0.15, 0.20);
  const cv         = meanRate > 0 ? sdRate / meanRate : 0.3;
  const spreadBonus= clamp(cv * 0.5, 0, 0.25);
  const raw = (
    boomNorm       * 40 +
    p90ratio       * 30 +
    minuteStability* 20 +
    varBonus       * 5  +
    spreadBonus    * 5
  );
  return Math.round(clamp(raw * 100, 0, 100));
}

// ═══════════════════════════════════════════════════════════════
// NBA API LAYER  (calls prop_lab_api.py backend)
// Change API_BASE to wherever you run the FastAPI server
// ═══════════════════════════════════════════════════════════════
const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE
  ? import.meta.env.VITE_API_BASE
  : "http://localhost:8000"
).replace(/\/+$/, ""); // strip trailing slash so URLs never get double-slash

// ─── Player Autocomplete ──────────────────────────────────────
function PlayerSearch({ value, onSelect, style: extraStyle = {} }) {
  const [query, setQuery]       = useState(value || "");
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [open, setOpen]         = useState(false);
  const [selected, setSelected] = useState(!!value);
  const debounceRef             = useRef(null);
  const wrapRef                 = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const search = (q) => {
    setQuery(q);
    setSelected(false);
    onSelect(null, null); // clear selection while typing
    if (q.length < 2) { setResults([]); setOpen(false); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API_BASE}/players/search?q=${encodeURIComponent(q)}`);
        if (r.ok) {
          const data = await r.json();
          setResults(Array.isArray(data) ? data : []);
          setOpen(true);
        } else {
          setResults([{ id: null, full_name: `Search error (HTTP ${r.status}) — is backend running?`, is_active: false, _error: true }]);
          setOpen(true);
        }
      } catch(e) {
        setResults([{ id: null, full_name: `Cannot reach backend — check VITE_API_BASE (${e.message})`, is_active: false, _error: true }]);
        setOpen(true);
      }
      setLoading(false);
    }, 280);
  };

  const pick = (p) => {
    setQuery(p.full_name);
    setSelected(true);
    setOpen(false);
    setResults([]);
    onSelect(p.id, p.full_name);
  };

  const inp = {
    ...extraStyle,
    background: "#0a1628",
    border: selected ? "1px solid #00e676" : "1px solid #1e3a5a",
    borderRadius: 6,
    color: "#e8f4fd",
    padding: "0.55rem 0.75rem",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "0.95rem",
    width: "100%",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        style={inp}
        placeholder="Search player…"
        value={query}
        onChange={e => search(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {loading && (
        <span style={{ position:"absolute", right:"0.6rem", top:"0.6rem",
          color:"#3a6080", fontFamily:"'JetBrains Mono',monospace", fontSize:"0.65rem" }}>
          searching…
        </span>
      )}
      {selected && (
        <span style={{ position:"absolute", right:"0.6rem", top:"0.65rem",
          color:"#00e676", fontSize:"0.8rem" }}>✓</span>
      )}
      {open && results.length > 0 && (
        <div style={{
          position:"absolute", top:"100%", left:0, right:0, zIndex:999,
          background:"#0a1628", border:"1px solid #2a4060", borderRadius:6,
          maxHeight:220, overflowY:"auto", boxShadow:"0 8px 24px #000a",
        }}>
          {results.map((p, idx) => (
            <div key={p.id ?? idx}
              onMouseDown={() => !p._error && pick(p)}
              style={{
                padding:"0.45rem 0.75rem", cursor:"pointer",
                fontFamily:"'JetBrains Mono',monospace", fontSize:"0.82rem",
                color: p.is_active ? "#e8f4fd" : "#5a7090",
                borderBottom:"1px solid #0e2040",
                display:"flex", justifyContent:"space-between", alignItems:"center",
              }}
              onMouseEnter={e => e.currentTarget.style.background="#1e3a5a"}
              onMouseLeave={e => e.currentTarget.style.background="transparent"}
            >
              <span>{p.full_name}</span>
              {!p.is_active && (
                <span style={{ fontSize:"0.6rem", color:"#3a6080", marginLeft:"0.5rem" }}>inactive</span>
              )}
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && !loading && query.length >= 2 && (
        <div style={{
          position:"absolute", top:"100%", left:0, right:0, zIndex:999,
          background:"#0a1628", border:"1px solid #2a4060", borderRadius:6,
          padding:"0.6rem 0.75rem",
          fontFamily:"'JetBrains Mono',monospace", fontSize:"0.75rem", color:"#3a6080",
        }}>
          No players found
        </div>
      )}
    </div>
  );
}

// ─── NBA Data Loader hook ─────────────────────────────────────
function useNBAData() {
  const [playerId,   setPlayerId]   = useState(null);
  const [playerName, setPlayerName] = useState("");
  const [season,     setSeason]     = useState("2025-26");
  const [seasons,    setSeasons]    = useState(["2025-26","2024-25","2023-24","2022-23","2021-22"]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [loaded,     setLoaded]     = useState(false);
  const [opponents,  setOpponents]  = useState([]);
  const [opponent,   setOpponent]   = useState("");
  const [nbaData,    setNbaData]    = useState(null); // raw response

  // Fetch seasons on mount
  useEffect(() => {
    fetch(`${API_BASE}/seasons`)
      .then(r => r.json())
      .then(data => { if(Array.isArray(data) && data.length > 0) setSeasons(data); })
      .catch(() => {}); // keep default seasons on any error
  }, []);

  const loadData = async (pid, pname, statType) => {
    if (!pid) return;
    setLoading(true);
    setError("");
    setLoaded(false);
    try {
      const url = `${API_BASE}/players/${pid}/gamelogs?stat_type=${encodeURIComponent(statType)}&season=${season}${opponent ? "&opponent=" + encodeURIComponent(opponent) : ""}`;
      // Use a generous fetch timeout — stats.nba.com can be slow
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000); // 90s client timeout
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setNbaData(data);
      setOpponents(data.opponents || []);
      setLoaded(true);
      return data;
    } catch (e) {
      const msg = e.name === "AbortError"
        ? "Request timed out — stats.nba.com is slow. Click Load again to retry."
        : (e.message || "Failed to load player data");
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return {
    playerId, setPlayerId, playerName, setPlayerName, setError,
    season, setSeason, seasons,
    loading, error, loaded, setLoaded,
    opponents, opponent, setOpponent,
    nbaData, loadData,
  };
}

// ═══════════════════════════════════════════════════════════════
// MATH HELPERS
// ═══════════════════════════════════════════════════════════════
function erf(x){
  const s=x>=0?1:-1; x=Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t=1/(1+p*x);
  return s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
// Box-Muller normal sample
function randNorm(mean=0,sd=1){
  const u=Math.random(),v=Math.random();
  return mean+sd*Math.sqrt(-2*Math.log(Math.max(1e-10,u)))*Math.cos(2*Math.PI*v);
}
// Heavy-tailed: blend normal with t-like by occasionally scaling sd
function randHeavy(mean,sd){
  const scaleFactor=Math.random()<0.15?2.2+Math.random()*1.8:1.0;
  return randNorm(mean,sd*scaleFactor);
}
function probToAmerican(p){
  p=Math.max(0.001,Math.min(0.999,p));
  if(p>=0.5) return `-${Math.round((p/(1-p))*100)}`;
  return `+${Math.round(((1-p)/p)*100)}`;
}
function median(arr){
  if(!arr.length) return null;
  const s=[...arr].sort((a,b)=>a-b);
  const m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function stddev(arr){
  if(arr.length<2) return arr[0]*0.25;
  const m=mean(arr);
  return Math.sqrt(arr.reduce((acc,v)=>acc+(v-m)**2,0)/(arr.length-1));
}
function percentile(sortedArr,p){
  const idx=(p/100)*(sortedArr.length-1);
  const lo=Math.floor(idx),hi=Math.ceil(idx);
  return sortedArr[lo]+(sortedArr[hi]-sortedArr[lo])*(idx-lo);
}
function h2hReliability(g){
  if(!g||g<1) return 0;
  if(g>=10) return 1.0; if(g>=5) return 0.9; if(g>=4) return 0.75;
  if(g>=3) return 0.6; if(g>=2) return 0.4; return 0.2;
}
function h2hLabel(g){
  if(!g||g<1) return {text:"NO DATA",color:"#3a6080"};
  if(g>=10) return {text:"HIGH RELIABILITY",color:"#00e676"};
  if(g>=5)  return {text:"SOLID SAMPLE",color:"#69f0ae"};
  if(g>=4)  return {text:"MODERATE",color:"#ffee58"};
  if(g>=3)  return {text:"SMALL SAMPLE",color:"#ff9800"};
  return {text:"⚠ OUTLIER RISK",color:"#ff7043"};
}
function smoothPct(count,total){
  // Laplace smoothing so we never return exact 0% or 100%
  return ((count+0.5)/(total+1))*100;
}


// ═══════════════════════════════════════════════════════════════
// MODEL CONSTANTS + ENHANCED HELPERS
// ═══════════════════════════════════════════════════════════════

// Stat-type volatility multipliers (applied to SD only, not mean)

// League avg rate is user-supplied per window — no hardcoded constant


// Compute matchup factors from opponent allowed totals
// oppAllowed: total stat allowed by opponent this season
// oppMinutes: total minutes played by opponents (default 48*82 = 3936 for a full season)
// oppAllowed: stat total allowed by opponent in that window
// leagueAvgAllowed: the league average for the same window (user-supplied)
// Both are divided by 48 to get per-minute rates — no separate minutes input needed

// Minutes stability: lower CV → more stable → higher confidence

// Shrinkage: blend recent weighted rate toward longer-term (plain) mean
// High variance → trust recent less → shrink more

// Boom / Bust from sim outcomes
function calcBoomBust(outcomes, propLine) {
  if (!outcomes || !outcomes.length || !propLine || propLine <= 0) return null;
  const boomLine = propLine * 1.25;
  const bustLine = propLine * 0.80;
  const n = outcomes.length;
  const boomCount = outcomes.filter(v => v >= boomLine).length;
  const bustCount = outcomes.filter(v => v <= bustLine).length;
  return {
    boomPct:  +smoothPct(boomCount, n).toFixed(1),
    bustPct:  +smoothPct(bustCount, n).toFixed(1),
    boomLine: +boomLine.toFixed(1),
    bustLine: +bustLine.toFixed(1),
    boomCount,
    bustCount,
  };
}


// ═══════════════════════════════════════════════════════════════
// MONTE CARLO ENGINE
// params: { meanRate, sdRate, meanMin, sdMin, projMin, matchupFactor, h2hMeanRate, h2hBlendW }
// ═══════════════════════════════════════════════════════════════
function runMonteCarlo({ meanRate, sdRate, meanMin, sdMin, projMin, matchupFactor=1, h2hMeanRate=null, h2hBlendW=0, iters=DEFAULT_ITERS }){
  const outcomes=new Array(iters);
  // widen sd to avoid unrealistically tight distribution
  const effSdRate=Math.max(sdRate, meanRate*0.12);
  const effSdMin=Math.max(sdMin, meanMin*0.1);
  const anchorMin=projMin>0?projMin:meanMin;

  for(let i=0;i<iters;i++){
    // simulate minutes anchored around projMin but shaped by historical sd
    const simMin=Math.max(1, randHeavy(anchorMin, effSdMin));
    // simulate stat-per-minute rate
    let simRate=Math.max(0, randHeavy(meanRate, effSdRate));
    // optional H2H blend
    if(h2hMeanRate!=null && h2hBlendW>0){
      const h2hRate=Math.max(0, randHeavy(h2hMeanRate, effSdRate));
      simRate=simRate*(1-h2hBlendW)+h2hRate*h2hBlendW;
    }
    outcomes[i]=simMin*simRate*matchupFactor;
  }
  outcomes.sort((a,b)=>a-b);

  const simMean=mean(outcomes);
  const simMedian=median(outcomes);
  const p10=percentile(outcomes,10);
  const p25=percentile(outcomes,25);
  const p75=percentile(outcomes,75);
  const p90=percentile(outcomes,90);

  return { outcomes, simMean, simMedian, p10, p25, p75, p90, iters };
}

function calcSimStats(outcomes, propLine){
  const n=outcomes.length;
  const overCount=outcomes.filter(v=>v>propLine).length;
  const underCount=n-overCount;
  const overPct=smoothPct(overCount,n);
  const underPct=100-overPct;
  const bb=calcBoomBust(outcomes, propLine);
  return {
    overCount, underCount,
    overPct:+overPct.toFixed(1),
    underPct:+underPct.toFixed(1),
    fairOver:probToAmerican(overPct/100),
    fairUnder:probToAmerican(underPct/100),
    ...bb,
  };
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY-INPUT ANALYSIS ENGINE (L5/L10/L20)
// oppAllowed: opponent season total for this stat (e.g. 2400 pts allowed)
// oppTotalMin: total minutes opponents played vs that team (default 3936)
// statType: used for vol multiplier + league avg rate lookup
// ═══════════════════════════════════════════════════════════════
function buildSummaryModel({ l5Avg,l5Mpg,l5Med,l10Avg,l10Mpg,l10Med,l20Avg,l20Mpg,l20Med,
                              l5OppAllowed='',l10OppAllowed='',l20OppAllowed='',leagueAvgAllowed='',
                              statType='Points',projMin,h2hAvg,h2hGames }){
  const windows=[];
  if(l5Avg&&l5Mpg)   windows.push({avg:+l5Avg, mpg:+l5Mpg, med:l5Med?+l5Med:null, w:0.5});
  if(l10Avg&&l10Mpg) windows.push({avg:+l10Avg,mpg:+l10Mpg,med:l10Med?+l10Med:null,w:0.3});
  if(l20Avg&&l20Mpg) windows.push({avg:+l20Avg,mpg:+l20Mpg,med:l20Med?+l20Med:null,w:0.2});
  if(!windows.length) return null;

  const rates=windows.map(w=>({rate:w.avg/w.mpg, medRate:w.med!=null?w.med/w.mpg:null, w:w.w, mpg:w.mpg}));
  const totalW=rates.reduce((a,r)=>a+r.w,0)||1;
  const normRates=rates.map(r=>({...r,w:r.w/totalW}));

  const weightedRate = normRates.reduce((acc,r)=>acc+r.rate*r.w,0);
  const medRates=normRates.filter(r=>r.medRate!=null).map(r=>r.medRate);
  const weightedMedianRate = medRates.length>0
    ? normRates.reduce((acc,r)=>acc+(r.medRate!=null?r.medRate:r.rate)*r.w,0)
    : (median(normRates.map(r=>r.rate))||weightedRate);

  // Season-mean rate for shrinkage anchor (longest window = most stable)
  const seasonMeanR = rates.length>0 ? rates[rates.length-1].rate : weightedRate;

  // Raw SD from avg-median spread
  const sigmaEstimates=normRates.filter(r=>r.medRate!=null).map(r=>Math.abs(r.rate-r.medRate)/0.798);
  const rawSdRate = sigmaEstimates.length>0
    ? Math.max(sigmaEstimates.reduce((a,b)=>a+b,0)/sigmaEstimates.length, weightedRate*0.08)
    : (normRates.length>1?stddev(normRates.map(r=>r.rate)):weightedRate*0.18);

  // Shrinkage: blend recent weighted rate toward season mean proportional to uncertainty
  const shrunkRate = applyShrinkage(weightedRate, seasonMeanR, rawSdRate, weightedRate);
  const blendedRate = shrunkRate*0.7 + weightedMedianRate*0.3;

  const weightedMpg = normRates.reduce((acc,r)=>acc+r.mpg*r.w,0)||
    (+l5Mpg||+l10Mpg||+l20Mpg||30);
  const pMin = projMin>0?+projMin:weightedMpg;
  const sdMin = weightedMpg*0.12;

  // Minute stability score
  const minuteStability = computeMinuteStability(sdMin, weightedMpg);

  // Matchup via opponent allowed rate (replaces rank-based factor)
  // Weighted opp allowed across L5/L10/L20 windows
  const oppWindows=[
    {v:parseFloat(l5OppAllowed)||0,  w:0.5},
    {v:parseFloat(l10OppAllowed)||0, w:0.3},
    {v:parseFloat(l20OppAllowed)||0, w:0.2},
  ].filter(x=>x.v>0);
  const oppTW=oppWindows.reduce((a,b)=>a+b.w,0)||1;
  const weightedOppAllowed=oppWindows.length>0?oppWindows.reduce((acc,x)=>acc+x.v*(x.w/oppTW),0):0;
  const matchup=computeMatchupFactors(weightedOppAllowed, parseFloat(leagueAvgAllowed)||0);
  // Values are already per-game averages — use directly
  const l5OppRate  =(parseFloat(l5OppAllowed)||0)>0  ?+(parseFloat(l5OppAllowed).toFixed(2))  :null;
  const l10OppRate =(parseFloat(l10OppAllowed)||0)>0 ?+(parseFloat(l10OppAllowed).toFixed(2)) :null;
  const l20OppRate =(parseFloat(l20OppAllowed)||0)>0 ?+(parseFloat(l20OppAllowed).toFixed(2)) :null;

  // Stat-type volatility multiplier applied to SD only
  const volMult = STAT_VOL_MULT[statType||"Points"] || 1.0;
  const sdRate = rawSdRate * matchup.matchupVarFactor * volMult;

  // Projection: blendedRate × minutes × matchup mean factor
  let baseProjection = blendedRate * pMin * matchup.matchupMeanFactor;

  // H2H: reduced max weight (15%) — used mainly as confidence signal
  let h2hBlend=null,h2hImpact=null,h2hMeanRate=null,h2hBlendW=0;
  const h2hA=parseFloat(h2hAvg),h2hG=parseInt(h2hGames);
  if(!isNaN(h2hA)&&h2hA>0&&!isNaN(h2hG)&&h2hG>0){
    const rel=h2hReliability(h2hG);
    h2hMeanRate=h2hA/pMin;
    h2hBlendW=rel*0.15; // reduced from 0.35 to prevent H2H dominating
    const h2hProj=h2hMeanRate*pMin*matchup.matchupMeanFactor;
    const pre=baseProjection;
    baseProjection=baseProjection*(1-h2hBlendW)+h2hProj*h2hBlendW;
    h2hBlend=rel;
    h2hImpact=((baseProjection-pre)/pre*100).toFixed(1);
  }

  return {
    weightedRate:+weightedRate.toFixed(4),
    medianRate:+weightedMedianRate.toFixed(4),
    shrunkRate:+shrunkRate.toFixed(4),
    blendedRate:+blendedRate.toFixed(4),
    meanRate:blendedRate, sdRate:+sdRate.toFixed(4),
    meanMin:+weightedMpg.toFixed(1), sdMin:+sdMin.toFixed(1),
    pMin, matchupFactor:matchup.matchupMeanFactor,
    matchupVarFactor:matchup.matchupVarFactor,
    matchupRatio:matchup.matchupRatio,
    matchupOppRate:matchup.oppRate,
    minuteStability:+minuteStability.toFixed(3),
    h2hBlend,h2hImpact,h2hMeanRate,h2hBlendW,
    projection:baseProjection,
    l5Rate:rates[0]?+rates[0].rate.toFixed(4):null,
    l10Rate:rates[1]?+rates[1].rate.toFixed(4):null,
    l20Rate:rates[2]?+rates[2].rate.toFixed(4):null,
    l5OppRate, l10OppRate, l20OppRate,
    statType, volMult,
  };
}
// ═══════════════════════════════════════════════════════════════
// GAME-LOG ANALYSIS ENGINE
// New: oppAllowed/oppTotalMin instead of ranks, statType for vol mult
// ═══════════════════════════════════════════════════════════════
function buildGameLogModel({ logs, h2hLogs, l5OppAllowed='', l10OppAllowed='', l20OppAllowed='', leagueAvgAllowed='', statType='Points',
                              projMin, h2hAvg, h2hGames,
                              useRecency=true, decayStrength=0.12 }){
  const valid=logs.filter(r=>r.min>0&&r.stat>=0&&!isNaN(r.min)&&!isNaN(r.stat));
  if(!valid.length) return null;

  const rates=valid.map(r=>r.stat/r.min);
  const mins=valid.map(r=>r.min);
  const n=valid.length;

  // Small-sample protection
  const sampleBlend = n>=5 ? 1.0 : n/5;
  const effectiveDecay = useRecency ? decayStrength * sampleBlend : 0;

  // Exponential decay weights (index 0 = most recent)
  const rawWeights = rates.map((_,i)=>Math.exp(-effectiveDecay * i));
  const wSum = rawWeights.reduce((a,b)=>a+b,0);
  const weights = rawWeights.map(w=>w/wSum);

  const weightedMeanR = weights.reduce((acc,w,i)=>acc+w*rates[i],0);
  const weightedMeanM = weights.reduce((acc,w,i)=>acc+w*mins[i],0);
  const plainMeanR = mean(rates);
  const plainMeanM = mean(mins);

  const usedMeanR = useRecency ? weightedMeanR : plainMeanR;
  const usedMeanM = useRecency ? weightedMeanM : plainMeanM;

  // Median is never recency-weighted
  const medianR = median(rates) || plainMeanR;

  // SD: blended weighted + unweighted when recency ON
  const unweightedSdR = n>=2 ? stddev(rates) : plainMeanR*0.20;
  const unweightedSdM = n>=2 ? stddev(mins)  : plainMeanM*0.12;
  const weightedVarR = n>=2 ? weights.reduce((acc,w,i)=>acc+w*(rates[i]-weightedMeanR)**2, 0) : (plainMeanR*0.20)**2;
  const weightedVarM = n>=2 ? weights.reduce((acc,w,i)=>acc+w*(mins[i]-weightedMeanM)**2,  0) : (plainMeanM*0.12)**2;
  const weightedSdR = Math.sqrt(weightedVarR);
  const weightedSdM = Math.sqrt(weightedVarM);
  const baseSdR = useRecency ? weightedSdR*0.5 + unweightedSdR*0.5 : unweightedSdR;
  const baseSdM = useRecency ? weightedSdM*0.5 + unweightedSdM*0.5 : unweightedSdM;

  // Shrinkage: blend recent toward season mean when uncertain
  const seasonMeanR = plainMeanR; // full-sample mean as anchor
  const shrunkRate  = applyShrinkage(usedMeanR, seasonMeanR, baseSdR, usedMeanR);
  const blendedR    = shrunkRate*0.7 + medianR*0.3;
  const pMin = projMin>0 ? +projMin : usedMeanM;

  // Minute stability
  const minuteStability = computeMinuteStability(baseSdM, usedMeanM);

  // Matchup via opponent allowed rate
  // Weighted opp allowed across L5/L10/L20 windows (same logic as summary model)
  const oppValsGL=[{v:parseFloat(l5OppAllowed)||0,w:0.5},{v:parseFloat(l10OppAllowed)||0,w:0.3},{v:parseFloat(l20OppAllowed)||0,w:0.2}].filter(x=>x.v>0);
  const oppTWGL=oppValsGL.reduce((a,b)=>a+b.w,0)||1;
  const weightedOppAllowedGL=oppValsGL.length>0?oppValsGL.reduce((a,b)=>a+b.v*(b.w/oppTWGL),0):0;
  const matchup=computeMatchupFactors(weightedOppAllowedGL, parseFloat(leagueAvgAllowed)||0);

  // Stat-type volatility multiplier (SD only)
  const volMult = STAT_VOL_MULT[statType||"Points"] || 1.0;
  const sdR  = baseSdR  * matchup.matchupVarFactor * volMult;
  const sdM  = baseSdM;

  let baseProjection = blendedR * pMin * matchup.matchupMeanFactor;

  // H2H: reduced projection weight, retained as variance/confidence signal
  let h2hMeanRate=null,h2hBlendW=0,h2hBlend=null,h2hImpact=null;
  let h2hStats=null;

  const validH2H=(h2hLogs||[]).filter(r=>r.min>0&&r.stat>=0);
  if(validH2H.length>0){
    const hr=validH2H.map(r=>r.stat/r.min);
    h2hMeanRate=mean(hr);
    const h2hMedianR=median(hr);
    const h2hSdR=hr.length>1?stddev(hr):h2hMeanRate*0.2;
    const h2hMeanM=mean(validH2H.map(r=>r.min));
    h2hStats={meanRate:+h2hMeanRate.toFixed(4),medianRate:+h2hMedianR.toFixed(4),
              sdRate:+h2hSdR.toFixed(4),meanMin:+h2hMeanM.toFixed(1),n:validH2H.length};
    const rel=h2hReliability(validH2H.length);
    h2hBlendW=rel*0.15; // reduced: H2H max 15% of projection
    h2hBlend=rel;
    const h2hProj=h2hMeanRate*pMin*matchup.matchupMeanFactor;
    const pre=baseProjection;
    baseProjection=baseProjection*(1-h2hBlendW)+h2hProj*h2hBlendW;
    h2hImpact=((baseProjection-pre)/pre*100).toFixed(1);
  } else {
    const h2hA=parseFloat(h2hAvg),h2hG=parseInt(h2hGames);
    if(!isNaN(h2hA)&&h2hA>0&&!isNaN(h2hG)&&h2hG>0){
      const rel=h2hReliability(h2hG);
      h2hMeanRate=h2hA/pMin;
      h2hBlendW=rel*0.15;
      h2hBlend=rel;
      const h2hProj=h2hMeanRate*pMin*matchup.matchupMeanFactor;
      const pre=baseProjection;
      baseProjection=baseProjection*(1-h2hBlendW)+h2hProj*h2hBlendW;
      h2hImpact=((baseProjection-pre)/pre*100).toFixed(1);
    }
  }

  return {
    meanRate:+blendedR.toFixed(4),
    plainMeanRate:+plainMeanR.toFixed(4),
    weightedMeanRate:+weightedMeanR.toFixed(4),
    shrunkRate:+shrunkRate.toFixed(4),
    medianRate:+medianR.toFixed(4),
    blendedRate:+blendedR.toFixed(4),
    sdRate:+sdR.toFixed(4),
    unweightedSdRate:+unweightedSdR.toFixed(4),
    weightedSdRate:+weightedSdR.toFixed(4),
    meanMin:+usedMeanM.toFixed(1),
    plainMeanMin:+plainMeanM.toFixed(1),
    weightedMeanMin:+weightedMeanM.toFixed(1),
    sdMin:+sdM.toFixed(1),
    unweightedSdMin:+unweightedSdM.toFixed(1),
    weightedSdMin:+weightedSdM.toFixed(1),
    pMin, matchupFactor:matchup.matchupMeanFactor,
    matchupVarFactor:matchup.matchupVarFactor,
    matchupRatio:matchup.matchupRatio,
    matchupOppRate:matchup.oppRate,
    minuteStability:+minuteStability.toFixed(3),
    h2hMeanRate, h2hBlendW, h2hBlend, h2hImpact, h2hStats,
    projection:baseProjection, n:valid.length,
    useRecency, decayStrength:effectiveDecay, sampleBlend,
    weights, statType, volMult,
  };
}
// ═══════════════════════════════════════════════════════════════
// GRADE + RECOMMENDATION from diff%
// ═══════════════════════════════════════════════════════════════
// ── Edge Score 0-100 ─────────────────────────────────────────
// Stat-type typical CV (coefficient of variation) — higher = more volatile stat
// Used to normalize edge% so +5% on rebounds ≠ +5% on points
const STAT_CV = {
  "Points":     0.28,
  "Rebounds":   0.45,
  "Assists":    0.50,
  "3-Pointers": 0.80,
  "Blocks":     0.90,
  "Steals":     0.85,
  "PRA":        0.22,
  "PR":         0.26,
  "PA":         0.28,
  "RA":         0.40,
};

function getEdgeScore({ diffPct, overPct, boomPct, bustPct, minuteStability, statType }){
  // 1. Normalize edge by stat volatility — high-variance stats need bigger edge to matter
  const cv = STAT_CV[statType] || 0.35;
  // edgeNorm: how many CVs away from neutral (50/50)
  // e.g. +10% edge on Points (cv=0.28) = 0.36 CVs  vs  +10% on Blocks (cv=0.90) = 0.11 CVs
  const edgeNorm = clamp((diffPct / 100) / cv, -1, 1); // -1 to +1

  // 2. Over probability — direct from sim (already accounts for variance)
  const overScore = clamp((overPct - 50) / 50, -1, 1); // -1 to +1

  // 3. Boom/bust ratio — how clean is the edge
  const bb = (boomPct || 0) - (bustPct || 0); // positive = more upside than downside
  const bbScore = clamp(bb / 30, -1, 1);

  // 4. Minutes stability penalty — unstable minutes reduce confidence
  const stabPenalty = (minuteStability != null) ? (minuteStability - 0.5) * 0.2 : 0;

  // Weighted composite: -1 to +1
  const raw = edgeNorm * 0.35 + overScore * 0.45 + bbScore * 0.15 + stabPenalty * 0.05;

  // Map to 0-100 with 50 = neutral (proj == line, 50% over prob)
  return Math.round(clamp(50 + raw * 50, 0, 100));
}

function scoreColor(score){
  if(score >= 70) return "#00e676";
  if(score >= 60) return "#69f0ae";
  if(score >= 52) return "#ffee58";
  if(score >= 45) return "#ff9800";
  return "#ff7043";
}

function scoreLabel(score){
  if(score >= 72) return "STRONG OVER";
  if(score >= 60) return "LEAN OVER";
  if(score >= 53) return "SLIGHT OVER";
  if(score >= 47) return "NEUTRAL";
  if(score >= 40) return "LEAN UNDER";
  if(score >= 28) return "STRONG UNDER";
  return "FADE";
}

// Keep getRec for history card compatibility
function getRec(diffPct){
  if(diffPct>=3) return {rec:"OVER",color:"#00e676"};
  if(diffPct<=-3) return {rec:"UNDER",color:"#ff7043"};
  return {rec:"PUSH / AVOID",color:"#ffee58"};
}

// getGrade kept for history backward compat — now maps score to letter
function getGrade(diffPct){ return diffPct >= 5 ? "OVER" : diffPct <= -5 ? "UNDER" : "PUSH"; }


// ─── Hit Rate Bar Chart ───────────────────────────────────────────────────────
function HitRateChart({ logs, h2hLogs, propLine, statType, dvpData, dvpOpp, l5Opp, l10Opp, l20Opp }) {
  const [activeTab, setActiveTab] = useState("L10");
  const [selectedBar, setSelectedBar] = useState(null); // {game, rank}

  const line = parseFloat(propLine);
  if (!logs || !logs.length || !line || line <= 0) return null;

  const allGames = logs.map(r => ({
    stat: parseFloat(r.stat), date: r.date || "",
    opp: (r.opponent||"").toUpperCase().trim(),
    min: parseFloat(r.min) || 0,
  })).filter(r => !isNaN(r.stat));

  const h2hGames = (h2hLogs || []).map(r => ({
    stat: parseFloat(r.stat), date: r.date || "", opp: "",
  })).filter(r => !isNaN(r.stat));

  // ── Matchup tab: find similar teams by weighted DvP rating ──────────────────
  const buildMatchupGames = () => {
    if (!dvpData || !dvpData.length || !dvpOpp) return [];
    const fields = STAT_TO_DVP[statType];
    if (!fields) return [];
    const [seasonField] = fields;

    const vals = [
      { v: parseFloat(l5Opp)||0,  w:0.5 },
      { v: parseFloat(l10Opp)||0, w:0.3 },
      { v: parseFloat(l20Opp)||0, w:0.2 },
    ].filter(x => x.v > 0);
    if (!vals.length) return [];

    const totalW    = vals.reduce((a,x)=>a+x.w,0);
    const weightedRating = vals.reduce((a,x)=>a+x.v*x.w,0)/totalW;

    // Sort by absolute distance from weighted rating, take 8 closest
    const similarTeams = dvpData
      .map(t=>({ abbr:(t.teamAbbr||"").toUpperCase(), val:parseFloat(t[seasonField])||0 }))
      .filter(t=>t.val>0)
      .sort((a,b)=>Math.abs(a.val-weightedRating)-Math.abs(b.val-weightedRating))
      .slice(0,8)
      .map(t=>t.abbr);

    if (!similarTeams.length) return [];
    return allGames.filter(g=>similarTeams.includes(g.opp));
  };

  const matchupGames = buildMatchupGames();

  const datasets = {
    "H2H":     h2hGames,
    "L5":      allGames.slice(0, 5),
    "L10":     allGames.slice(0, 10),
    "L20":     allGames.slice(0, 20),
    "Season":  allGames,
    "Matchup": matchupGames,
  };
  const tabs = ["H2H","L5","L10","L20","Season","Matchup"];

  // Resolve active tab — fall back if empty
  const games = (datasets[activeTab] || []).length > 0
    ? datasets[activeTab]
    : datasets["L10"].length > 0 ? datasets["L10"] : allGames;

  // Compute rank for each opponent from dvpData (30=most allowed=easiest, 1=least=hardest)
  const getOppRank = (oppAbbr) => {
    if (!dvpData || !dvpData.length || !oppAbbr) return null;
    const fields = STAT_TO_DVP[statType];
    if (!fields) return null;
    const [seasonField] = fields;
    const ranked = [...dvpData]
      .map(t=>({ abbr:(t.teamAbbr||"").toUpperCase(), val:parseFloat(t[seasonField])||0 }))
      .filter(t=>t.val>0)
      .sort((a,b)=>a.val-b.val); // rank 1 = lowest allowed (toughest), rank 30 = highest (easiest)
    const idx = ranked.findIndex(t=>t.abbr===oppAbbr.toUpperCase());
    if (idx===-1) return null;
    return { rank: idx+1, total: ranked.length, val: ranked[idx].val };
  };

  const hits   = games.filter(g => g.stat >= line).length;
  const avg    = +(games.reduce((a,b) => a + b.stat, 0) / games.length).toFixed(1);
  const sorted = [...games].sort((a,b) => a.stat - b.stat);
  const med    = +sorted[Math.floor(sorted.length / 2)].stat.toFixed(1);

  const W = 340, H = 185;
  const PAD = { top: 26, right: 16, bottom: 44, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;
  const maxVal = Math.max(...games.map(g => g.stat), line) * 1.18;
  const yScale = v => chartH - (v / maxVal) * chartH;
  const gap    = chartW / games.length;
  const barW   = Math.max(4, Math.min(26, gap * 0.68));
  const lineY  = yScale(line);

  return (
    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,
      padding:"1.25rem",marginBottom:"1rem"}}>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:"0.6rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a"}}>
        <span style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",
          fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase"}}>
          Hit Rate Chart
        </span>
        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",color:"#3a6080"}}>
          line: <span style={{color:"#e8f4fd"}}>{line}</span>
        </span>
      </div>

      {/* Hit rate % for each window */}
      <div style={{display:"flex",gap:"0.9rem",flexWrap:"wrap",marginBottom:"0.4rem"}}>
        {tabs.filter(t => (datasets[t]||[]).length > 0).map(t => {
          const d   = datasets[t];
          const h   = d.filter(g => g.stat >= line).length;
          const pct = Math.round((h / d.length) * 100);
          const col = pct>=60?"#00e676":pct>=50?"#ffee58":"#ff7043";
          const active = t === activeTab;
          return (
            <div key={t} onClick={() => setActiveTab(t)}
              style={{textAlign:"center",cursor:"pointer",
                opacity: active ? 1 : 0.55,
                transition:"opacity 0.15s"}}>
              <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",
                fontSize:"0.58rem",letterSpacing:"0.08em"}}>{t}</div>
              <div style={{color:col,fontFamily:"'Black Han Sans',sans-serif",
                fontSize:"1.15rem",lineHeight:1.1,
                textDecoration: active ? "underline" : "none",
                textUnderlineOffset:"3px"}}>{pct}%</div>
            </div>
          );
        })}
      </div>

      {/* Avg / median for selected window */}
      <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.67rem",
        color:"#3a6080",marginBottom:"0.75rem"}}>
        Average <span style={{color:"#e8f4fd",fontWeight:700}}>{avg}</span>
        <span style={{margin:"0 0.4rem",color:"#1e3050"}}>·</span>
        Median <span style={{color:"#e8f4fd",fontWeight:700}}>{med}</span>
        <span style={{color:"#2a4060",marginLeft:"0.5rem"}}>({hits}/{games.length} over)</span>
      </div>

      {/* Chart tabs */}
      <div style={{display:"flex",gap:"0.3rem",marginBottom:"0.6rem",flexWrap:"wrap"}}>
        {tabs.map(t => {
          const d = datasets[t] || [];
          const disabled = d.length === 0;
          return (
            <button key={t} onClick={() => !disabled && setActiveTab(t)}
              style={{padding:"0.2rem 0.55rem",
                background: activeTab===t ? "#4a9eff" : "#0a1628",
                color: disabled?"#1e3050": activeTab===t?"#050d1a":"#3a6080",
                border:`1px solid ${activeTab===t?"#4a9eff":disabled?"#0e2040":"#1e3a5a"}`,
                borderRadius:5,fontFamily:"'JetBrains Mono',monospace",
                fontSize:"0.62rem",cursor:disabled?"not-allowed":"pointer"}}>
              {t}{!disabled&&<span style={{opacity:0.6,marginLeft:"0.25rem",fontSize:"0.55rem"}}>({d.length})</span>}
            </button>
          );
        })}
      </div>

      {/* SVG Bar Chart */}
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
        {/* Background zones */}
        <rect x={PAD.left} y={PAD.top} width={chartW} height={lineY}
          fill="#00e67606" rx={2}/>
        <rect x={PAD.left} y={PAD.top+lineY} width={chartW} height={chartH-lineY}
          fill="#ff704306" rx={2}/>

        {/* Y gridlines */}
        {[0,0.25,0.5,0.75,1].map(t => {
          const v = t * maxVal;
          const y = PAD.top + yScale(v);
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={PAD.left+chartW} y2={y}
                stroke="#0a1e38" strokeWidth="1"/>
              <text x={PAD.left-3} y={y+3} textAnchor="end"
                fill="#1e3050" fontSize="7.5" fontFamily="monospace">
                {Math.round(v)}
              </text>
            </g>
          );
        })}

        {/* Bars: index 0 = newest = rightmost */}
        {games.map((g, i) => {
          const x      = PAD.left + (games.length - 1 - i) * gap + gap/2 - barW/2;
          const hit    = g.stat >= line;
          const bh     = Math.max(3, (g.stat / maxVal) * chartH);
          const by     = PAD.top + chartH - bh;
          const col    = hit ? "#00e676" : "#ef5350";
          const isSel  = selectedBar && selectedBar.index === i;
          return (
            <g key={i} style={{cursor:"pointer"}}
              onClick={() => {
                if (isSel) { setSelectedBar(null); return; }
                const rankInfo = getOppRank(g.opp);
                setSelectedBar({ game: g, index: i, rankInfo });
              }}>
              <rect x={x} y={by} width={barW} height={bh}
                fill={col} fillOpacity={isSel ? 1 : 0.82} rx={2}
                stroke={isSel ? "#fff" : "none"} strokeWidth={isSel ? 1 : 0}/>
              <text x={x+barW/2} y={by-2} textAnchor="middle"
                fill={col} fontSize="7.5" fontFamily="monospace" fontWeight="700">
                {Number.isInteger(g.stat)?g.stat:g.stat.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* Prop line */}
        <line x1={PAD.left} y1={PAD.top+lineY} x2={PAD.left+chartW} y2={PAD.top+lineY}
          stroke="#c8d8e8" strokeWidth="1.5" strokeDasharray="5 3"/>
        <text x={PAD.left+chartW+2} y={PAD.top+lineY+4}
          fill="#c8d8e8" fontSize="8.5" fontFamily="monospace" fontWeight="700">
          {line}
        </text>

        {/* X axis: date under each bar when ≤10 games, else first+last only */}
        {games.length <= 10
          ? games.map((g, i) => {
              const x = PAD.left + (games.length - 1 - i) * gap + gap/2;
              const label = (g.date||"").slice(5); // MM-DD
              return label ? (
                <text key={i} x={x} y={H-4} textAnchor="middle"
                  fill="#1e3050" fontSize="7" fontFamily="monospace"
                  transform={`rotate(-35, ${x}, ${H-4})`}>
                  {label}
                </text>
              ) : null;
            })
          : games.length > 1 && <>
              <text x={PAD.left+gap/2} y={H-4} textAnchor="middle"
                fill="#1e3050" fontSize="7.5" fontFamily="monospace">
                {(games[games.length-1]?.date||"").slice(5)}
              </text>
              <text x={PAD.left+chartW-gap/2} y={H-4} textAnchor="middle"
                fill="#1e3050" fontSize="7.5" fontFamily="monospace">
                {(games[0]?.date||"").slice(5)}
              </text>
            </>
        }
      </svg>

      {/* Bar detail popup */}
      {selectedBar && (() => {
        const { game, rankInfo } = selectedBar;
        const rankNum = rankInfo?.rank;
        const rankTotal = rankInfo?.total || 30;
        // Color: 30 (easiest) = green, 1 (hardest) = red
        const rankColor = rankNum
          ? `hsl(${((rankNum-1)/(rankTotal-1))*120},80%,55%)`
          : "#8ba7c0";
        return (
          <div style={{margin:"0.5rem 0",background:"#050d1a",border:"1px solid #1e3a5a",
            borderRadius:8,padding:"0.6rem 0.85rem",fontFamily:"'JetBrains Mono',monospace",
            fontSize:"0.7rem",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.3rem 1rem"}}>
            {[
              ["OPP",  game.opp || "—",  "#e8f4fd"],
              ["DATE", game.date || "—", "#8ba7c0"],
              ["MINS", game.min != null ? parseFloat(game.min).toFixed(1) : "—", "#8ba7c0"],
              ["RANK", rankNum
                ? <span style={{color:rankColor,fontWeight:700}}>{rankNum}</span>
                : "—",
              "#e8f4fd"],
            ].map(([lbl,val,col])=>(
              <div key={lbl}>
                <div style={{color:"#2a4060",fontSize:"0.55rem",letterSpacing:"0.1em",marginBottom:"0.1rem"}}>{lbl}</div>
                <div style={{color:col}}>{val}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Matchup tab: show which teams were included */}
      {activeTab === "Matchup" && matchupGames.length > 0 && dvpData && (() => {
        const fields = STAT_TO_DVP[statType];
        if (!fields) return null;
        const [seasonField] = fields;
        const vals = [
          { v: parseFloat(l5Opp)||0, w:0.5 },
          { v: parseFloat(l10Opp)||0, w:0.3 },
          { v: parseFloat(l20Opp)||0, w:0.2 },
        ].filter(x=>x.v>0);
        const totalW = vals.reduce((a,x)=>a+x.w,0);
        const wr = vals.reduce((a,x)=>a+x.v*x.w,0)/totalW;
        const similar = dvpData
          .map(t=>({abbr:(t.teamAbbr||"").toUpperCase(), val:parseFloat(t[seasonField])||0}))
          .filter(t=>t.val>0)
          .sort((a,b)=>Math.abs(a.val-wr)-Math.abs(b.val-wr))
          .slice(0,8);
        return (
          <div style={{marginTop:"0.5rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",lineHeight:1.7}}>
            <span style={{color:"#3a6080"}}>8 closest matchups to {dvpOpp} ({wr.toFixed(1)} allowed): </span>
            <span style={{color:"#1e3050"}}>{similar.map(t=>`${t.abbr} (${t.val})`).join(", ")}</span>
          </div>
        );
      })()}
      {activeTab === "Matchup" && matchupGames.length === 0 && (
        <div style={{marginTop:"0.5rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",color:"#2a4060",textAlign:"center"}}>
          No similar matchups found — try selecting an opponent in the DvP panel first
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════
function ScoreBadge({score, size="lg"}){
  const col = scoreColor(score);
  const lbl = scoreLabel(score);
  const fs  = size==="lg" ? "3rem" : size==="md" ? "1.8rem" : "1.1rem";
  const subFs = size==="lg" ? "0.65rem" : "0.52rem";
  return(
    <div style={{textAlign:"center",display:"inline-block"}}>
      <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:fs,fontWeight:900,
        color:col,lineHeight:1,textShadow:`0 0 20px ${col}80`}}>
        {score}
      </div>
      <div style={{color:col,fontFamily:"'JetBrains Mono',monospace",fontSize:subFs,
        letterSpacing:"0.08em",marginTop:"0.1em",opacity:0.85}}>
        {size!=="sm"?lbl:""}
      </div>
    </div>
  );
}
// Kept for history cards
function GradeBadge({grade,size="lg"}){
  return <ScoreBadge score={typeof grade==="number"?grade:50} size={size}/>;
}
function Bar({value,color,height=8}){
  return <div style={{background:"#0a1628",borderRadius:4,height,overflow:"hidden"}}><div style={{width:`${Math.min(100,Math.max(0,value))}%`,height:"100%",background:color,borderRadius:4,transition:"width 0.8s ease"}}/></div>;
}
function Ring({pct,color,label}){
  const r=28,circ=2*Math.PI*r,dash=(Math.min(100,Math.max(0,pct))/100)*circ;
  return(
    <div style={{textAlign:"center"}}>
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r={r} fill="none" stroke="#0a1628" strokeWidth="7"/>
        <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="7" strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ*0.25} strokeLinecap="round" style={{transition:"stroke-dasharray 0.8s ease"}}/>
        <text x="36" y="40" textAnchor="middle" fill={color} style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"13px"}}>{pct<0.1?"<0.1":pct>99.9?">99.9":pct.toFixed(1)}%</text>
      </svg>
      <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",letterSpacing:"0.1em",marginTop:"0.15rem"}}>{label}</div>
    </div>
  );
}
function OddsChip({label,value,color}){
  return(
    <div style={{background:"#050d1a",border:`1px solid ${color}30`,borderRadius:8,padding:"0.6rem 0.75rem",textAlign:"center",flex:1}}>
      <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.1em",marginBottom:"0.25rem"}}>{label}</div>
      <div style={{color,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.4rem",lineHeight:1}}>{value}</div>
      <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.52rem",marginTop:"0.2rem"}}>FAIR ODDS</div>
    </div>
  );
}
function H2HBar({games}){
  const rel=h2hReliability(games);
  const {text,color}=h2hLabel(games);
  const pct=rel*100;
  const segs=[{pct:20,label:"1G"},{pct:40,label:"2G"},{pct:60,label:"3G"},{pct:75,label:"4G"},{pct:90,label:"5G"},{pct:100,label:"10G+"}];
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.4rem"}}>
        <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",letterSpacing:"0.08em"}}>SAMPLE RELIABILITY</span>
        <span style={{color,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.75rem",letterSpacing:"0.08em"}}>{text}</span>
      </div>
      <div style={{position:"relative",background:"#050d1a",borderRadius:6,height:12,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:`linear-gradient(90deg,#ff7043,#ffee58,${color})`,borderRadius:6,transition:"width 0.8s ease"}}/>
        {segs.map(s=><div key={s.pct} style={{position:"absolute",top:0,left:`${s.pct}%`,height:"100%",width:1,background:"#0a1628"}}/>)}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:"0.25rem"}}>
        {segs.map(s=><span key={s.pct} style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>{s.label}</span>)}
      </div>
    </div>
  );
}
function StatRow({label,val,dim,color="#e8f4fd"}){
  return(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"0.3rem 0",borderBottom:"1px solid #0e1e30"}}>
      <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",letterSpacing:"0.06em"}}>{label}</span>
      <span style={{color,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem",fontWeight:600}}>{val}<span style={{color:"#2a4060",fontSize:"0.65rem",marginLeft:"0.3rem"}}>{dim}</span></span>
    </div>
  );
}

// ─── Monte Carlo display card ─────────────────────────────────
function MonteCarloCard({sim,simStats,propLine}){
  if(!sim) return null;
  return(
    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
      <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span>Monte Carlo Simulation</span>
        <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",letterSpacing:"0.1em"}}>{sim.iters.toLocaleString()} ITERS</span>
      </div>

      {/* mean/median row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.75rem",marginBottom:"0.75rem"}}>
        <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",textAlign:"center"}}>
          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em"}}>SIM MEAN</div>
          <div style={{color:"#e8f4fd",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.6rem",lineHeight:1.1}}>{sim.simMean.toFixed(1)}</div>
        </div>
        <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",textAlign:"center"}}>
          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em"}}>SIM MEDIAN</div>
          <div style={{color:"#e8f4fd",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.6rem",lineHeight:1.1}}>{sim.simMedian.toFixed(1)}</div>
        </div>
      </div>

      {/* percentile band */}
      <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",marginBottom:"0.75rem"}}>
        <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em",marginBottom:"0.5rem",textAlign:"center"}}>OUTCOME RANGE — how spread out results could be</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"0.4rem",textAlign:"center"}}>
          {[
            ["P10","BAD GAME",sim.p10,"#ff7043","1-in-10 floor"],
            ["P25","LOW END",sim.p25,"#ffee58","1-in-4 floor"],
            ["P75","HIGH END",sim.p75,"#69f0ae","1-in-4 ceiling"],
            ["P90","BIG GAME",sim.p90,"#00e676","1-in-10 ceiling"],
          ].map(([code,lbl,val,c,sub])=>(
            <div key={code} style={{background:"#050d1a",borderRadius:6,padding:"0.5rem 0.3rem"}}>
              <div style={{color:c,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.7rem",letterSpacing:"0.05em"}}>{lbl}</div>
              <div style={{color:c,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.2rem",lineHeight:1.1,margin:"0.2rem 0"}}>{val.toFixed(1)}</div>
              <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.52rem",lineHeight:1.3}}>{sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* over/under probabilities + fair odds */}
      <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",marginBottom:"0.75rem"}}>
        <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em",marginBottom:"0.6rem",textAlign:"center"}}>vs LINE {propLine}</div>
        <div style={{display:"flex",justifyContent:"center",gap:"1rem",alignItems:"center",marginBottom:"0.6rem"}}>
          <Ring pct={simStats.overPct} color="#00e676" label="OVER %"/>
          <OddsChip label="OVER" value={simStats.fairOver} color="#00e676"/>
          <OddsChip label="UNDER" value={simStats.fairUnder} color="#ff7043"/>
          <Ring pct={simStats.underPct} color="#ff7043" label="UNDER %"/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.5rem"}}>
          <div style={{textAlign:"center"}}>
            <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem"}}>OVER COUNT  </span>
            <span style={{color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.8rem",fontWeight:600}}>{simStats.overCount.toLocaleString()}</span>
          </div>
          <div style={{textAlign:"center"}}>
            <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem"}}>UNDER COUNT  </span>
            <span style={{color:"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.8rem",fontWeight:600}}>{simStats.underCount.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Alt line checker ─────────────────────────────────────────
function AltChecker({simOutcomes}){
  const [alt,setAlt]=useState("");
  const altNum=parseFloat(alt);
  const altStats=(!isNaN(altNum)&&altNum>0&&simOutcomes)?calcSimStats(simOutcomes,altNum):null;
  const inp={background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,color:"#e8f4fd",padding:"0.5rem 0.75rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"1rem",width:"100%",outline:"none",boxSizing:"border-box"};
  return(
    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
      <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a"}}>Check Another Line</div>
      <input style={inp} type="number" step="0.5" placeholder="e.g. 27.5" value={alt} onChange={e=>setAlt(e.target.value)}/>
      {altStats&&(
        <div style={{marginTop:"0.75rem"}}>
          <div style={{display:"flex",justifyContent:"center",gap:"1rem",alignItems:"center",marginBottom:"0.5rem"}}>
            <Ring pct={altStats.overPct} color="#00e676" label="OVER %"/>
            <OddsChip label="OVER" value={altStats.fairOver} color="#00e676"/>
            <OddsChip label="UNDER" value={altStats.fairUnder} color="#ff7043"/>
            <Ring pct={altStats.underPct} color="#ff7043" label="UNDER %"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.5rem",textAlign:"center"}}>
            <span style={{color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem"}}>OVER {altStats.overCount.toLocaleString()}</span>
            <span style={{color:"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem"}}>UNDER {altStats.underCount.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── History card ─────────────────────────────────────────────
function HistCard({e,onDel,onLoad}){
  const rc=e.result.recommendation==="OVER"?"#00e676":e.result.recommendation==="UNDER"?"#ff7043":"#ffee58";
  const inputLabel = e.inputMode==="gamelog"
    ? (e.logSubTab==="paste"?"📋 Paste":"✏️ Manual")
    : "📊 Summary";
  return(
    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:10,padding:"1rem",marginBottom:"0.75rem"}}>
      {/* Header row */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"0.5rem"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.15rem"}}>
            <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#e8f4fd",fontSize:"1.1rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.form?.playerName||e.logForm?.playerName||"—"}</div>
            <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",flexShrink:0}}>{inputLabel}</span>
          </div>
          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.68rem"}}>
            {(e.form?.statType||e.logForm?.statType||"—")} · LINE {e.activePropLine||e.form?.prop||"—"} · {e.ts}
          </div>
        </div>
        <ScoreBadge score={typeof e.result.grade==="number"?e.result.grade:50} size="sm"/>
      </div>
      {/* Stats row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"0.5rem",marginBottom:"0.65rem"}}>
        {[["PROJ",e.result.projection,"#e8f4fd"],["LEAN",e.result.recommendation,rc],["OVER %",e.result.simStats?e.result.simStats.overPct+"%":"—","#00e676"],["ODDS",e.result.simStats?e.result.simStats.fairOver:"—","#4a9eff"]].map(([h,v,c])=>(
          <div key={h} style={{background:"#0a1628",borderRadius:6,padding:"0.45rem 0.5rem",textAlign:"center"}}>
            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.56rem",letterSpacing:"0.08em"}}>{h}</div>
            <div style={{color:c,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.95rem",marginTop:"0.1rem"}}>{v}</div>
          </div>
        ))}
      </div>
      {/* Action buttons */}
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"0.5rem"}}>
        <button onClick={()=>onLoad(e)}
          style={{padding:"0.45rem 0.75rem",background:"#1e3a5a",color:"#4a9eff",border:"1px solid #4a9eff",borderRadius:7,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.75rem",letterSpacing:"0.1em",cursor:"pointer",transition:"all 0.15s"}}>
          ↩ LOAD
        </button>
        <button onClick={()=>onDel(e.id)}
          style={{padding:"0.45rem 0.6rem",background:"transparent",color:"#2a4060",border:"1px solid #1e3a5a",borderRadius:7,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.8rem",cursor:"pointer"}}>
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Game log row editor ──────────────────────────────────────
function GameLogEditor({logs,onChange,placeholder="Recent games (newest first)"}){
  const inp={background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:5,color:"#e8f4fd",padding:"0.4rem 0.5rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem",outline:"none",boxSizing:"border-box",width:"100%"};
  const addRow=()=>onChange([...logs,{min:"",stat:""}]);
  const delRow=i=>onChange(logs.filter((_,idx)=>idx!==i));
  const edit=(i,k,v)=>onChange(logs.map((r,idx)=>idx===i?{...r,[k]:v}:r));
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"30px 1fr 1fr 28px",gap:"0.4rem",marginBottom:"0.35rem"}}>
        <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",textAlign:"center"}}>#</span>
        <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem"}}>MIN</span>
        <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem"}}>STAT</span>
        <span/>
      </div>
      {logs.map((row,i)=>(
        <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr 1fr 28px",gap:"0.4rem",marginBottom:"0.35rem",alignItems:"center"}}>
          <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",textAlign:"center"}}>{i+1}</span>
          <input style={inp} type="number" step="0.1" placeholder="32" value={row.min} onChange={e=>edit(i,"min",e.target.value)}/>
          <input style={inp} type="number" step="0.1" placeholder="28" value={row.stat} onChange={e=>edit(i,"stat",e.target.value)}/>
          <button onClick={()=>delRow(i)} style={{background:"none",border:"none",color:"#2a4060",cursor:"pointer",fontSize:"0.9rem",padding:0}}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{marginTop:"0.35rem",background:"transparent",border:"1px dashed #1e3a5a",borderRadius:6,color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",padding:"0.4rem 0.8rem",cursor:"pointer",width:"100%"}}>+ Add Game</button>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// PASTE PARSER ENGINE
// ═══════════════════════════════════════════════════════════════

// Map stat type → column header variants to search for in pasted text
const STAT_COL_MAP = {
  "Points":      ["PTS","PT"],
  "Rebounds":    ["REB","TRB","RB"],
  "Assists":     ["AST","AS"],
  "3-Pointers":  ["3PM","3P","3FG","FG3M"],
  "Blocks":      ["BLK","BK"],
  "Steals":      ["STL","ST"],
  "PRA":         ["PRA","P+R+A","PR+A","P+R+A"],
  "PR":          ["P+R","PR","PTS+REB","P_R"],
  "PA":          ["P+A","PA","PTS+AST","P_A"],
  "RA":          ["R+A","RA","REB+AST","R_A"],
};

// Date patterns: Oct 15, 10/15, 10-15-2024, 2024-10-15, etc.
const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}-\d{2}-\d{2}/gi;

function normalizeDate(raw) {
  if(!raw) return null;
  const s = raw.trim().replace(/\s+/g,' ');
  // Try to extract a consistent key
  const m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2})/i);
  if(m) return `${m[1].slice(0,3)}-${m[2].padStart(2,'0')}`;
  const dm = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if(dm) return `${dm[1].padStart(2,'0')}-${dm[2].padStart(2,'0')}${dm[3]?'-'+dm[3]:''}`;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[2]}-${iso[3]}-${iso[1]}`;
  return s.slice(0,12);
}

function parseMinutes(raw) {
  if(!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if(raw==='' || raw==='-' || raw==='DNP' || raw==='DND' || raw==='INJ') return null;
  // Handle MM:SS format
  const mms = raw.match(/^(\d{1,3}):(\d{2})$/);
  if(mms) return parseFloat(mms[1]) + parseFloat(mms[2])/60;
  const n = parseFloat(raw);
  return isNaN(n)||n<=0 ? null : n;
}

function parseStatVal(raw) {
  if(!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if(raw==='' || raw==='-' || raw==='—') return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

function splitLine(line) {
  // Split by tabs first, then collapse multiple spaces
  if(line.includes('\t')) return line.split('\t').map(c=>c.trim());
  return line.split(/\s{2,}|\s*\|\s*/).map(c=>c.trim()).filter((_,i,a)=>i===0||a[i-1]!==undefined);
}

function isJunkRow(cells) {
  if(!cells || cells.length<2) return true;
  const joined = cells.join('').trim();
  if(!joined || joined.replace(/[-\s]/g,'').length===0) return true;
  // All dashes
  if(cells.every(c=>!c||c==='-'||c==='—'||c==='')) return true;
  return false;
}

// Core parser — handles BOTH normal row-per-game AND the wrapped vertical format
// where stats sites paste headers as one-column-name-per-line, then values one-per-line.
function parsePastedLogs(rawText, statType) {
  if(!rawText || !rawText.trim()) return [];

  const lines = rawText.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
  const candidates = STAT_COL_MAP[statType] || ["PTS"];

  // Known stat column names — excludes ambiguous words (DATE, SCORE, GAME, TO, ST, PT)
  // that appear in schedule sections and cause false header detection.
  const KNOWN_COLS = ['MP','MIN','PTS','REB','TRB','AST','P+A','R+A','P+R+A','P+R',
    '3PM','3PA','3FG','FGM','FGA','FTM','FTA','BLK','STL','TO','TOV',
    'PF','FP','2X2','3X3','RA','PA','PR','PRA','FG%','FT%','3P%'];

  // ── STRATEGY 1: VERTICAL HEADER (one column name per line) ───
  // Detect a run of ≥5 consecutive known stat columns that INCLUDES 'MP' or 'MIN'.
  // Requiring MP prevents false triggers on schedule words like DATE/SCORE/GAME LOG.
  let vHeaderStart = -1, vHeaderEnd = -1;
  for(let i=0;i<lines.length-4;i++){
    let run=0, j=i;
    while(j<lines.length && KNOWN_COLS.includes(lines[j].toUpperCase())){run++;j++;}
    if(run>=5){
      const runCols = lines.slice(i,j).map(s=>s.toUpperCase());
      if(runCols.includes('MP')||runCols.includes('MIN')){
        vHeaderStart=i; vHeaderEnd=j-1; break;
      }
    }
  }

  if(vHeaderStart!==-1){
    const headers = lines.slice(vHeaderStart, vHeaderEnd+1).map(s=>s.toUpperCase());
    const numCols = headers.length;
    const mpIdx   = headers.findIndex(c=>c==='MP'||c==='MIN');
    const statIdx = headers.findIndex(c=>candidates.some(cand=>
      c===cand.toUpperCase() || c.replace(/\+/g,'')===cand.replace(/\+/g,'').toUpperCase()
    ));
    if(mpIdx===-1||statIdx===-1) return [];

    // Harvest dates from schedule section (lines before vHeaderStart)
    // Dates look like: 3/29/26  or  10/23/25  (M/D/YY or M/D/YYYY)
    const scheduleDates=[];
    for(let i=0;i<vHeaderStart;i++){
      if(/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(lines[i])) scheduleDates.push(normalizeDate(lines[i]));
    }

    // Collect tokens after the header block
    // Convert Y/N to 1/0 so chunk size stays = numCols (Y/N are valid col values e.g. 2x2, 3x3)
    const tokens=[];
    for(let i=vHeaderEnd+1;i<lines.length;i++){
      const t=lines[i];
      if(!t) continue;
      const u=t.toUpperCase();
      if(KNOWN_COLS.includes(u)) continue;    // skip repeated headers
      if(u==='Y') { tokens.push('1'); continue; }  // Y/N → 1/0, preserve chunk alignment
      if(u==='N') { tokens.push('0'); continue; }
      if(!/^-?\d/.test(t)) continue;          // skip non-numeric non-YN tokens
      tokens.push(t);
    }

    // Chunk tokens into rows of numCols each
    // The FIRST chunk is the "Avg. w/ filters" summary row — always skip it
    // Then map remaining chunks to schedule dates in order
    const rows=[], seenDates=new Set();
    let datePtr=0;
    let chunkIdx=0;

    for(let offset=0; offset+numCols<=tokens.length; offset+=numCols, chunkIdx++){
      // Skip chunk 0 — it's always the season/filter averages row, not a real game
      if(chunkIdx===0) continue;

      const chunk=tokens.slice(offset, offset+numCols);
      const minVal  = parseMinutes(chunk[mpIdx]);
      const statVal = parseStatVal(chunk[statIdx]);
      if(minVal===null||minVal<1||statVal===null) continue;

      // Assign schedule dates in order; stop when we run out of dates
      if(datePtr>=scheduleDates.length) break;
      const dateStr=scheduleDates[datePtr];
      datePtr++;

      if(seenDates.has(dateStr)) continue;
      seenDates.add(dateStr);
      rows.push({ date:dateStr, min:+minVal.toFixed(1), stat:statVal, rate:+(statVal/minVal).toFixed(4) });
    }
    return rows;
  }

  // ── STRATEGY 2: STANDARD ROW-PER-GAME FORMAT ─────────────────
  // Find a single header line with MP + stat col separated by tabs/spaces
  let headerIdx=-1, headers=[];
  for(let i=0;i<lines.length;i++){
    const cells = lines[i].includes('\t') ? lines[i].split('\t') : lines[i].split(/\s{2,}|\s*\|\s*/);
    const upper = cells.map(c=>c.trim().toUpperCase());
    if(!upper.some(c=>c==='MP'||c==='MIN')) continue;
    if(!upper.some(c=>candidates.some(cand=>c===cand.toUpperCase()||c.replace(/\+/g,'')===cand.replace(/\+/g,'').toUpperCase()))) continue;
    headerIdx=i; headers=upper; break;
  }
  if(headerIdx===-1) return [];

  const mpIdx   = headers.findIndex(c=>c==='MP'||c==='MIN');
  const statIdx = headers.findIndex(c=>candidates.some(cand=>
    c===cand.toUpperCase()||c.replace(/\+/g,'')===cand.replace(/\+/g,'').toUpperCase()
  ));
  const rows=[], seenDates=new Set();

  for(let i=headerIdx+1;i<lines.length;i++){
    const line=lines[i];
    if(!line) continue;
    const cells=line.includes('\t')?line.split('\t'):line.split(/\s{2,}|\s*\|\s*/);
    if(cells.length<=Math.max(mpIdx,statIdx)) continue;
    const up0=(cells[0]||'').toUpperCase().trim();
    if(up0==='DATE'||up0==='MP'||up0==='MIN') continue;
    if(cells.every(c=>!c.trim()||c.trim()==='-'||c.trim()==='—')) continue;

    const minVal  = parseMinutes(cells[mpIdx]);
    const statVal = parseStatVal(cells[statIdx]);
    if(minVal===null||minVal<1||statVal===null) continue;

    let dateStr=null;
    for(let ci=0;ci<Math.min(4,cells.length);ci++){
      const dm=(cells[ci]||'').match(DATE_RE);
      if(dm){dateStr=normalizeDate(dm[0]);break;}
    }
    if(!dateStr) dateStr=`row-${i}`;
    if(seenDates.has(dateStr)) continue;
    seenDates.add(dateStr);
    rows.push({ date:dateStr, min:+minVal.toFixed(1), stat:statVal, rate:+(statVal/minVal).toFixed(4) });
  }
  return rows;
}


// ─── Simulation Distribution Chart ───────────────────────────
function SimDistChart({outcomes, propLine, projection, p10, p25, p50, p75, p90}) {
  const [hovered, setHovered] = useState(null); // {bucketIdx, x, y}
  const svgRef = useRef(null);
  if(!outcomes||outcomes.length===0) return null;

  const W=320, H=160, PADL=6, PADR=6, PADT=20, PADB=55;
  const plotW=W-PADL-PADR, plotH=H-PADT-PADB;

  // Clip axis to P1-P99
  const p1idx  = Math.floor(outcomes.length*0.01);
  const p99idx = Math.ceil(outcomes.length*0.99)-1;
  const lo = outcomes[Math.max(0,p1idx)];
  const hi = outcomes[Math.min(outcomes.length-1,p99idx)];
  const range=Math.max(hi-lo,0.1);
  const BUCKETS=40;
  const bucketSize=range/BUCKETS;
  const counts=new Array(BUCKETS).fill(0);
  outcomes.forEach(v=>{
    if(v<lo||v>hi) return;
    const b=Math.min(BUCKETS-1,Math.floor((v-lo)/bucketSize));
    counts[b]++;
  });
  const maxCount=Math.max(...counts,1);
  const totalVisible=counts.reduce((a,b)=>a+b,0);

  const xScale=v=>PADL+(Math.min(1,Math.max(0,(v-lo)/range)))*plotW;
  const xPropLine=xScale(parseFloat(propLine)||0);
  const xProj=xScale(projection||0);

  // Convert SVG coords to bucket index
  const svgXToBucket=(svgX)=>{
    const frac=(svgX-PADL)/plotW;
    return Math.min(BUCKETS-1,Math.max(0,Math.floor(frac*BUCKETS)));
  };

  const handleMouseMove=(e)=>{
    if(!svgRef.current) return;
    const rect=svgRef.current.getBoundingClientRect();
    const svgX=((e.clientX-rect.left)/rect.width)*W;
    const svgY=((e.clientY-rect.top)/rect.height)*H;
    if(svgX<PADL||svgX>PADL+plotW||svgY<PADT||svgY>PADT+plotH){ setHovered(null); return; }
    const bi=svgXToBucket(svgX);
    setHovered({bi, svgX, svgY});
  };

  const hov = hovered!=null ? {
    lo: lo+hovered.bi*bucketSize,
    hi: lo+(hovered.bi+1)*bucketSize,
    count: counts[hovered.bi],
    pct: totalVisible>0?(counts[hovered.bi]/totalVisible*100):0,
  } : null;

  // Tooltip position: render BELOW the axis, clamp horizontally
  const tipW=92, tipH=48;
  let tipX = hovered ? hovered.svgX - tipW/2 : 0;
  // Place below the plot area (below axis line)
  const tipY = PADT + plotH + 4;
  tipX = Math.max(PADL, Math.min(PADL+plotW-tipW, tipX));

  return(
    <div style={{background:"#050d1a",borderRadius:8,padding:"0.6rem",overflow:"hidden",position:"relative"}}>
      <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em",marginBottom:"0.4rem",textAlign:"center"}}>
        OUTCOME DISTRIBUTION ({outcomes.length.toLocaleString()} sims) — hover to inspect
      </div>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        style={{display:"block",cursor:"crosshair"}}
        onMouseMove={handleMouseMove} onMouseLeave={()=>setHovered(null)}>

        {/* Bars */}
        {counts.map((c,i)=>{
          const bx=PADL+(i/BUCKETS)*plotW;
          const bw=Math.max(1,(plotW/BUCKETS)-0.5);
          const bh=(c/maxCount)*plotH;
          const by=PADT+plotH-bh;
          const bucketMid=lo+(i+0.5)*bucketSize;
          const isOver=bucketMid>(parseFloat(propLine)||0);
          const isHov=hovered&&hovered.bi===i;
          return <rect key={i} x={bx} y={by} width={bw} height={bh}
            fill={isHov?"#ffffff60":isOver?"#00e67640":"#ff704340"}
            stroke={isHov?"#ffffffc0":isOver?"#00e67680":"#ff704380"}
            strokeWidth={isHov?0.8:0.3}/>;
        })}

        {/* Hover vertical crosshair */}
        {hovered&&(
          <line x1={hovered.svgX} y1={PADT} x2={hovered.svgX} y2={PADT+plotH}
            stroke="#ffffff30" strokeWidth="0.8" strokeDasharray="1 2"/>
        )}

        {/* Axis line */}
        <line x1={PADL} y1={PADT+plotH} x2={PADL+plotW} y2={PADT+plotH} stroke="#1e3a5a" strokeWidth="1"/>

        {/* Percentile markers */}
        {[
          {v:p10,label:"P10",color:"#ff7043"},
          {v:p25,label:"P25",color:"#ffee58"},
          {v:p50,label:"MED",color:"#8ba7c0"},
          {v:p75,label:"P75",color:"#69f0ae"},
          {v:p90,label:"P90",color:"#00e676"},
        ].map(({v,label,color})=>{
          if(v==null) return null;
          const x=xScale(v);
          if(x<PADL||x>PADL+plotW) return null;
          return <g key={label}>
            <line x1={x} y1={PADT} x2={x} y2={PADT+plotH} stroke={color} strokeWidth="0.7" strokeDasharray="2 2" opacity="0.6"/>
            <text x={x} y={PADT-4} textAnchor="middle" fill={color} fontSize="6" fontFamily="monospace">{label}</text>
          </g>;
        })}

        {/* Prop line */}
        {propLine&&(()=>{
          const x=xPropLine;
          if(x<PADL||x>PADL+plotW) return null;
          return <g>
            <line x1={x} y1={PADT-2} x2={x} y2={PADT+plotH+2} stroke="#ffffff" strokeWidth="1.5"/>
            <text x={x} y={PADT+plotH+20} textAnchor="middle" fill="#ffffff" fontSize="6.5" fontFamily="monospace" fontWeight="bold">LINE {parseFloat(propLine).toFixed(1)}</text>
          </g>;
        })()}

        {/* Projection triangle */}
        {projection&&(()=>{
          const x=xProj;
          if(x<PADL||x>PADL+plotW) return null;
          return <g>
            <polygon points={`${x},${PADT+5} ${x-4},${PADT-2} ${x+4},${PADT-2}`} fill="#4a9eff"/>
            <text x={x} y={PADT+plotH+32} textAnchor="middle" fill="#4a9eff" fontSize="6.5" fontFamily="monospace">PROJ {projection.toFixed(1)}</text>
          </g>;
        })()}

        {/* Axis labels — just below axis line */}
        <text x={PADL} y={PADT+plotH+10} fill="#2a4060" fontSize="6" fontFamily="monospace">{lo.toFixed(1)}</text>
        <text x={PADL+plotW} y={PADT+plotH+10} textAnchor="end" fill="#2a4060" fontSize="6" fontFamily="monospace">{hi.toFixed(1)}</text>

        {/* Hover tooltip — rendered last so it's on top */}
        {hov&&hovered&&(
          <g transform={`translate(${tipX},${tipY})`}>
            <rect x="0" y="0" width={tipW} height={tipH} rx="3" fill="#0a1628" stroke="#2a4060" strokeWidth="0.8" opacity="0.97"/>
            <text x={tipW/2} y="10" textAnchor="middle" fill="#3a6080" fontSize="5.5" fontFamily="monospace">RANGE</text>
            <text x={tipW/2} y="20" textAnchor="middle" fill="#e8f4fd" fontSize="7" fontFamily="monospace" fontWeight="bold">{hov.lo.toFixed(1)} – {hov.hi.toFixed(1)}</text>
            <text x={tipW/2} y="31" textAnchor="middle" fill="#4a9eff" fontSize="6.5" fontFamily="monospace">{hov.count.toLocaleString()} sims</text>
            <text x={tipW/2} y="42" textAnchor="middle" fill="#00e676" fontSize="6.5" fontFamily="monospace">{hov.pct.toFixed(1)}% of dist</text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Paste Log Preview Table ──────────────────────────────────
// weights: optional array of recency weights (same length as rows), null when recency OFF
function ParsedPreview({rows, label, statType, useRecency=false, decayStrength=0.12}) {
  if(!rows||rows.length===0) return null;

  // Compute display weights using same formula as model
  let displayWeights = null;
  if(useRecency && rows.length>0){
    const n=rows.length;
    const sampleBlend = n>=5 ? 1.0 : n/5;
    const effDecay = decayStrength * sampleBlend;
    const raw = rows.map((_,i)=>Math.exp(-effDecay*i));
    const wSum = raw.reduce((a,b)=>a+b,0);
    displayWeights = raw.map(w=>+(w/wSum).toFixed(4));
  }

  const showW = useRecency && displayWeights;
  const cols = showW ? "80px 48px 48px 60px 52px" : "90px 55px 55px 70px";
  const headers = showW ? ["DATE","MIN",statType.toUpperCase().slice(0,5),"RATE","WEIGHT"] : ["DATE","MIN",statType.toUpperCase().slice(0,5),"RATE"];

  return(
    <div style={{marginTop:"0.75rem"}}>
      <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",letterSpacing:"0.1em",marginBottom:"0.4rem",display:"flex",justifyContent:"space-between"}}>
        <span>{label} — {rows.length} game{rows.length!==1?"s":""} parsed</span>
        {showW&&<span style={{color:"#4a9eff"}}>λ={decayStrength.toFixed(2)}</span>}
      </div>
      <div style={{background:"#050d1a",borderRadius:6,overflow:"hidden",border:"1px solid #0e2040"}}>
        <div style={{display:"grid",gridTemplateColumns:cols,gap:0,borderBottom:"1px solid #1e3a5a",padding:"0.3rem 0.5rem"}}>
          {headers.map(h=>(
            <span key={h} style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.08em"}}>{h}</span>
          ))}
        </div>
        {rows.map((r,i)=>{
          const w = showW ? displayWeights[i] : null;
          // Fade weight color from bright→dim as weight decreases
          const wPct = w ? w/displayWeights[0] : 0;
          const wColor = `rgba(74,158,255,${0.35+wPct*0.65})`;
          return(
            <div key={i} style={{display:"grid",gridTemplateColumns:cols,gap:0,padding:"0.25rem 0.5rem",borderBottom:i<rows.length-1?"1px solid #0a1628":"none",background:i%2===0?"#050d1a":"#080f1e"}}>
              <span style={{color:"#8ba7c0",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.date||"—"}</span>
              <span style={{color:"#e8f4fd",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem"}}>{parseFloat(r.min).toFixed(1)}</span>
              <span style={{color:"#4a9eff",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem"}}>{r.stat}</span>
              <span style={{color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem"}}>{r.rate!=null?r.rate:(parseFloat(r.min)>0?(parseFloat(r.stat)/parseFloat(r.min)).toFixed(3):"—")}</span>
              {showW&&<span style={{color:wColor,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem"}}>{(w*100).toFixed(1)}%</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Paste Log Panel ─────────────────────────────────────────
function PasteLogPanel({statType, onParsed, onH2HParsed, useRecency=false, decayStrength=0.12}) {
  const [rawRecent, setRawRecent] = useState("");
  const [rawH2H,    setRawH2H]    = useState("");
  const [parsedRecent, setParsedRecent] = useState(null);
  const [parsedH2H,    setParsedH2H]    = useState(null);
  const [error, setError] = useState("");

  const handleParse = () => {
    setError("");
    const recent = parsePastedLogs(rawRecent, statType);
    const h2h    = parsePastedLogs(rawH2H,    statType);
    if(rawRecent.trim() && recent.length===0) {
      setError("Could not find a stat table in the pasted text. Make sure it includes MP and "+statType+" columns.");
      return;
    }
    setParsedRecent(recent.length>0 ? recent : null);
    setParsedH2H(h2h.length>0 ? h2h : null);
    if(recent.length>0) onParsed(recent.map(r=>({min:String(r.min.toFixed(1)),stat:String(r.stat)})));
    if(h2h.length>0)    onH2HParsed(h2h.map(r=>({min:String(r.min.toFixed(1)),stat:String(r.stat)})));
  };

  const TA = {
    width:"100%", minHeight:120, background:"#050d1a",
    border:"1px solid #1e3a5a", borderRadius:6, color:"#e8f4fd",
    fontFamily:"'JetBrains Mono',monospace", fontSize:"0.72rem",
    padding:"0.6rem 0.75rem", resize:"vertical", outline:"none", boxSizing:"border-box",
    lineHeight:1.5,
  };

  return(
    <div>
      <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",marginBottom:"0.5rem"}}>
        Paste copied game log text below — the parser will find the stat table automatically.
        Stat column used: <span style={{color:"#4a9eff"}}>{statType}</span>
      </div>

      <div style={{marginBottom:"1rem"}}>
        <label style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.75rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.3rem"}}>
          Recent Game Log (paste here)
        </label>
        <textarea style={TA} placeholder={"Paste raw copied text from a stats site...\n\nExample:\nDate\tOpp\tW/L\tMP\tPTS\tREB\tAST\n10/28\t@BOS\tW 112-108\t34:12\t28\t6\t5"} value={rawRecent} onChange={e=>setRawRecent(e.target.value)}/>
      </div>

      <div style={{marginBottom:"1rem"}}>
        <label style={{color:"#ff9800",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.75rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.3rem"}}>
          H2H Log vs This Opponent (optional)
        </label>
        <textarea style={{...TA,borderColor:"#2a3a1a"}} placeholder={"Paste H2H game logs against tonight's opponent..."}value={rawH2H} onChange={e=>setRawH2H(e.target.value)}/>
      </div>

      {error&&<div style={{color:"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",marginBottom:"0.75rem",padding:"0.5rem 0.75rem",background:"#1a0a08",borderRadius:6,border:"1px solid #3a1a10"}}>{error}</div>}

      <button onClick={handleParse} style={{width:"100%",padding:"0.7rem",background:"#1e3a5a",color:"#4a9eff",border:"1px solid #4a9eff",borderRadius:8,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.95rem",letterSpacing:"0.1em",cursor:"pointer",marginBottom:"0.75rem"}}>
        🔍 PARSE PASTED LOGS
      </button>

      <ParsedPreview rows={parsedRecent} label="RECENT GAMES" statType={statType} useRecency={useRecency} decayStrength={decayStrength}/>
      {parsedH2H&&<div style={{marginTop:"0.75rem"}}><ParsedPreview rows={parsedH2H} label="H2H GAMES" statType={statType} useRecency={useRecency} decayStrength={decayStrength}/></div>}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// DvP (Defense vs Position) AUTO-FILL HOOK
// Source: Google Sheets (public CSV export)
// ═══════════════════════════════════════════════════════════════

const SHEET_ID = "1rDtv9fqTgWre7u5H8N8idbxtOabR-DuPseqStgSgQ3Q";
const SHEET_BASE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
const POSITIONS = ["PG","SG","SF","PF","C"];

// Parse a CSV string into an array of row objects keyed by header names
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  // Google Sheets CSV wraps values in quotes; strip them carefully
  const parseRow = (line) => {
    const cols = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols;
  };
  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => {
      const raw = vals[i] ?? "";
      // Try numeric parse; fall back to string
      const n = parseFloat(raw);
      obj[h] = isNaN(n) ? raw : n;
    });
    return obj;
  }).filter(r => r.teamAbbr || r.teamName); // skip blank rows
}

// Map UI stat type → API field names [season, l5, l10, l20]
const STAT_TO_DVP = {
  "Points":     ["ptsAvg",  "l5PtsAvg",  "l10PtsAvg",  "l20PtsAvg"],
  "Rebounds":   ["rebAvg",  "l5RebAvg",  "l10RebAvg",  "l20RebAvg"],
  "Assists":    ["astAvg",  "l5AstAvg",  "l10AstAvg",  "l20AstAvg"],
  "3-Pointers": ["fg3mAvg", "l5Fg3mAvg", "l10Fg3mAvg", "l20Fg3mAvg"],
  "Steals":     ["stlAvg",  "l5StlAvg",  "l10StlAvg",  "l20StlAvg"],
  "Blocks":     ["blkAvg",  "l5BlkAvg",  "l10BlkAvg",  "l20BlkAvg"],
  "PRA":        ["praAvg",  "l5PraAvg",  "l10PraAvg",  "l20PraAvg"],
  "PR":         ["prAvg",   "l5PrAvg",   "l10PrAvg",   "l20PrAvg"],
  "PA":         ["paAvg",   "l5PaAvg",   "l10PaAvg",   "l20PaAvg"],
  "RA":         ["raAvg",   "l5RaAvg",   "l10RaAvg",   "l20RaAvg"],
};

function useDvP() {
  const [position,   setPosition]   = useState("PG");
  const [dvpData,    setDvpData]    = useState(null);   // full API response teams array
  const [dvpLoading, setDvpLoading] = useState(false);
  const [dvpError,   setDvpError]   = useState("");
  // Sheet tabs are position-only (always current season) — no season param needed
  const cacheRef = useRef({});  // position+season → data, avoids re-fetching

  const fetchDvP = useCallback(async (pos) => {
    // season param no longer needed — sheet tabs are per-position, always current
    const key = pos;
    if (cacheRef.current[key]) {
      setDvpData(cacheRef.current[key]);
      setDvpError("");
      return cacheRef.current[key];
    }
    setDvpLoading(true);
    setDvpError("");
    try {
      const url = `${SHEET_BASE}${encodeURIComponent(pos)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const teams = parseCsv(text);
      if (!teams.length) throw new Error("Sheet returned no data — check tab name and sharing");
      cacheRef.current[key] = teams;
      setDvpData(teams);
      setDvpError("");
      return teams;
    } catch(e) {
      setDvpError(e.message || "Failed to load sheet");
      return null;
    } finally {
      setDvpLoading(false);
    }
  }, []);

  // Fetch whenever position or season changes
  useEffect(() => { fetchDvP(position); }, [position, fetchDvP]);

  // Given a team abbr/name and stat type, return the matchup values
  const getMatchupValues = useCallback((teamQuery, statType, teams) => {
    const src = teams || dvpData;
    if (!src || !teamQuery) return null;
    const q = teamQuery.trim().toUpperCase();
    const team = src.find(t =>
      (t.teamAbbr||"").toUpperCase() === q ||
      (t.teamName||"").toUpperCase().includes(q)
    );
    if (!team) return null;
    const fields = STAT_TO_DVP[statType];
    if (!fields) return null;
    const [season, l5, l10, l20] = fields;
    // Sheet values are already per-game averages — use directly, no conversion needed
    const toVal = (v) => (v != null && !isNaN(parseFloat(v)) && parseFloat(v) > 0)
      ? +parseFloat(v).toFixed(2) : "";
    return {
      l5OppAllowed:  toVal(team[l5]),
      l10OppAllowed: toVal(team[l10]),
      l20OppAllowed: toVal(team[l20]),
    };
  }, [dvpData]);

  // Calculate league average for a stat across all teams (dynamic)
  const getLeagueAvg = useCallback((statType, teams) => {
    const src = teams || dvpData;
    if (!src || src.length === 0) return "";
    const fields = STAT_TO_DVP[statType];
    if (!fields) return "";
    const seasonField = fields[0];
    const vals = src.map(t => parseFloat(t[seasonField])).filter(v => v > 0 && !isNaN(v));
    if (!vals.length) return "";
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    // Sheet values are per-game averages — return directly
    return +avg.toFixed(2);
  }, [dvpData]);

  const teamList = dvpData ? dvpData.map(t => t.teamAbbr).filter(Boolean).sort() : [];

  return {
    position, setPosition,
    dvpData, dvpLoading, dvpError,
    fetchDvP, getMatchupValues, getLeagueAvg,
    teamList,
  };
}

// ─── DvP Matchup Panel Component ─────────────────────────────
// Shared between summary and gamelog modes
// onFill(values) called when auto-fill fires: {l5OppAllowed, l10OppAllowed, l20OppAllowed, leagueAvgAllowed}
function DvPPanel({ statType, dvp, onFill, currentOpp, onOppChange }) {
  const [localOpp, setLocalOpp] = useState(currentOpp || "");
  const [lastFilled, setLastFilled] = useState(""); // track what triggered last fill

  // Sync localOpp if parent resets
  useEffect(() => { setLocalOpp(currentOpp || ""); }, [currentOpp]);

  const tryAutoFill = useCallback((opp, data) => {
    if (!opp || !data) return;
    const key = `${opp}:${statType}`;
    if (key === lastFilled) return; // don't re-fill same combo
    const vals = dvp.getMatchupValues(opp, statType, data);
    if (!vals) return;
    const leagueAvg = dvp.getLeagueAvg(statType, data);
    onFill({ ...vals, leagueAvgAllowed: String(leagueAvg) });
    setLastFilled(key);
  }, [dvp, statType, lastFilled, onFill]);

  // Auto-fill when dvpData arrives and we already have an opp selected
  useEffect(() => {
    if (dvp.dvpData && localOpp) tryAutoFill(localOpp, dvp.dvpData);
  }, [dvp.dvpData, statType]); // fires on stat or data change too

  // Reset lastFilled when position changes so re-fill can happen
  useEffect(() => { setLastFilled(""); }, [dvp.position, statType]);

  const handleOppSelect = (opp) => {
    setLocalOpp(opp);
    onOppChange(opp);
    setLastFilled(""); // allow fill for new opp
    if (dvp.dvpData) tryAutoFill(opp, dvp.dvpData);
  };

  const S2 = {background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,color:"#e8f4fd",
    padding:"0.5rem 0.65rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.88rem",
    width:"100%",outline:"none",boxSizing:"border-box",cursor:"pointer"};

  return (
    <div style={{background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.85rem",marginBottom:"0.75rem"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.65rem"}}>
        <span style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.68rem",letterSpacing:"0.18em",textTransform:"uppercase"}}>
          Auto DvP Matchup
        </span>
        {dvp.dvpLoading && (
          <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>fetching…</span>
        )}
        {dvp.dvpError && (
          <div style={{marginTop:"0.5rem",color:"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",lineHeight:1.5}}>
            ⚠ Sheet unavailable — check the sheet is public (File → Share → Anyone with link)
            <div style={{color:"#5a4040",marginTop:"0.15rem",fontSize:"0.55rem"}}>{dvp.dvpError}</div>
          </div>
        )}
        {!dvp.dvpLoading && !dvp.dvpError && dvp.dvpData && (
          <span style={{color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>✓ {dvp.dvpData.length} teams</span>
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.65rem"}}>
        {/* Position selector */}
        <div>
          <label style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.25rem"}}>Position</label>
          <select style={S2} value={dvp.position} onChange={e=>dvp.setPosition(e.target.value)}>
            {POSITIONS.map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        {/* Opponent selector */}
        <div>
          <label style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.25rem"}}>Opponent</label>
          <select style={S2} value={localOpp} onChange={e=>handleOppSelect(e.target.value)}>
            <option value="">— Select team —</option>
            {dvp.teamList.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {localOpp && dvp.dvpData && !dvp.getMatchupValues(localOpp, statType, dvp.dvpData) && (
        <div style={{color:"#ffee58",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.4rem"}}>
          Team not found in dataset — check abbreviation
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EDGE FINDER COMPONENT
// ═══════════════════════════════════════════════════════════════
function EdgeFinder({ apiBase, onAnalyze }) {
  const [gameDate,   setGameDate]   = useState(() => new Date().toISOString().slice(0,10).replace(/-/g,""));
  const [games,      setGames]      = useState([]);
  const [gamesLoad,  setGamesLoad]  = useState(false);
  const [gamesErr,   setGamesErr]   = useState("");
  const [allProps,   setAllProps]   = useState([]);   // all props across all games
  const [propCache,  setPropCache]  = useState({});   // gameID → props[]
  const [loading,    setLoading]    = useState(false);
  const [loadedGames,setLoadedGames]= useState(new Set());
  const [gameFilter, setGameFilter] = useState("All"); // "All" or gameID
  const [statFilter, setStatFilter] = useState("All");
  const [search,     setSearch]     = useState("");

  const STAT_FILTERS = ["All","Points","Rebounds","Assists","3-Pointers","PRA","PR","PA","RA","Blocks","Steals"];

  // Load schedule
  const loadGames = async (date) => {
    setGamesLoad(true); setGamesErr(""); setGames([]);
    setAllProps([]); setPropCache({}); setLoadedGames(new Set());
    setGameFilter("All");
    try {
      const r = await fetch(`${apiBase}/edge/schedule?gameDate=${date}`);
      if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.detail||`HTTP ${r.status}`); }
      const data = await r.json();
      setGames(Array.isArray(data) ? data : []);
      if (!data.length) setGamesErr("No games found for this date.");
    } catch(e) { setGamesErr(e.message||"Failed to load schedule"); }
    finally { setGamesLoad(false); }
  };

  useEffect(() => { loadGames(gameDate); }, []);

  // Load props for ALL games when games list arrives
  useEffect(() => {
    if (!games.length) return;
    const fetchAll = async () => {
      setLoading(true);
      const newCache = {};
      const allP = [];
      for (const game of games) {
        try {
          const r = await fetch(`${apiBase}/edge/odds?gameID=${encodeURIComponent(game.gameID)}`);
          if (!r.ok) continue;
          const data = await r.json();
          const sorted = (Array.isArray(data) ? data : [])
            .map(p => ({...p, gameID: game.gameID, away: game.away, home: game.home}))
            .sort((a,b) => b.line - a.line);
          newCache[game.gameID] = sorted;
          allP.push(...sorted);
          // Update incrementally so props appear as each game loads
          setPropCache({...newCache});
          setAllProps([...allP].sort((a,b) => b.line - a.line));
          setLoadedGames(prev => new Set([...prev, game.gameID]));
        } catch {}
      }
      setLoading(false);
    };
    fetchAll();
  }, [games]);

  // Compute filtered props
  const filteredProps = allProps.filter(p => {
    if (gameFilter !== "All" && p.gameID !== gameFilter) return false;
    if (statFilter !== "All" && p.statType !== statFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!p.playerName.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const loadedCount = loadedGames.size;
  const totalGames  = games.length;

  return (
    <div>
      {/* Header */}
      <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,
        padding:"1rem 1.25rem",marginBottom:"1rem"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          marginBottom:"0.75rem"}}>
          <span style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",
            fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase"}}>
            ⚡ Edge Finder
          </span>
          {loading && (
            <span style={{fontFamily:"'JetBrains Mono',monospace",color:"#3a6080",fontSize:"0.62rem"}}>
              Loading {loadedCount}/{totalGames} games...
            </span>
          )}
          {!loading && allProps.length > 0 && (
            <span style={{fontFamily:"'JetBrains Mono',monospace",color:"#3a6080",fontSize:"0.62rem"}}>
              {allProps.length} props · {totalGames} games
            </span>
          )}
        </div>

        {/* Date picker */}
        <div style={{display:"flex",gap:"0.5rem",alignItems:"center"}}>
          <input type="date"
            value={`${gameDate.slice(0,4)}-${gameDate.slice(4,6)}-${gameDate.slice(6,8)}`}
            onChange={e => { const d=e.target.value.replace(/-/g,""); setGameDate(d); loadGames(d); }}
            style={{background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,
              color:"#e8f4fd",padding:"0.45rem 0.65rem",fontFamily:"'JetBrains Mono',monospace",
              fontSize:"0.78rem",flex:1,outline:"none"}}
          />
          <button onClick={()=>loadGames(gameDate)}
            style={{padding:"0.45rem 0.9rem",background:"#1e3a5a",border:"none",
              borderRadius:6,color:"#4a9eff",fontFamily:"'Black Han Sans',sans-serif",
              fontSize:"0.8rem",cursor:"pointer"}}>↺</button>
        </div>

        {gamesLoad && <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",marginTop:"0.5rem"}}>Loading schedule...</div>}
        {gamesErr  && <div style={{color:"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",marginTop:"0.5rem"}}>{gamesErr}</div>}
      </div>

      {allProps.length > 0 && (
        <div>
          {/* Player search */}
          <input
            placeholder="Search player..."
            value={search}
            onChange={e=>setSearch(e.target.value)}
            style={{width:"100%",background:"#080f1e",border:"1px solid #1e3a5a",
              borderRadius:8,color:"#e8f4fd",padding:"0.55rem 0.75rem",
              fontFamily:"'JetBrains Mono',monospace",fontSize:"0.78rem",
              outline:"none",marginBottom:"0.65rem",boxSizing:"border-box"}}
          />

          {/* Game filter */}
          <div style={{display:"flex",gap:"0.3rem",flexWrap:"wrap",marginBottom:"0.5rem"}}>
            <button onClick={()=>setGameFilter("All")}
              style={{padding:"0.2rem 0.55rem",
                background:gameFilter==="All"?"#4a9eff":"#0a1628",
                color:gameFilter==="All"?"#050d1a":"#3a6080",
                border:`1px solid ${gameFilter==="All"?"#4a9eff":"#1e3a5a"}`,
                borderRadius:5,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",cursor:"pointer"}}>
              All Games
            </button>
            {games.map(g => (
              <button key={g.gameID} onClick={()=>setGameFilter(g.gameID)}
                style={{padding:"0.2rem 0.55rem",
                  background:gameFilter===g.gameID?"#4a9eff":"#0a1628",
                  color:gameFilter===g.gameID?"#050d1a":"#3a6080",
                  border:`1px solid ${gameFilter===g.gameID?"#4a9eff":"#1e3a5a"}`,
                  borderRadius:5,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",cursor:"pointer",
                  opacity: loadedGames.has(g.gameID) ? 1 : 0.4}}>
                {g.away}@{g.home}
                {!loadedGames.has(g.gameID) && <span style={{marginLeft:"0.3rem",opacity:0.5}}>...</span>}
              </button>
            ))}
          </div>

          {/* Stat filter */}
          <div style={{display:"flex",gap:"0.3rem",flexWrap:"wrap",marginBottom:"0.75rem"}}>
            {STAT_FILTERS.map(f=>(
              <button key={f} onClick={()=>setStatFilter(f)}
                style={{padding:"0.2rem 0.55rem",
                  background:statFilter===f?"#4a9eff":"#0a1628",
                  color:statFilter===f?"#050d1a":"#3a6080",
                  border:`1px solid ${statFilter===f?"#4a9eff":"#1e3a5a"}`,
                  borderRadius:5,fontFamily:"'JetBrains Mono',monospace",
                  fontSize:"0.62rem",cursor:"pointer"}}>
                {f}
              </button>
            ))}
          </div>

          {/* Results count */}
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",
            color:"#2a4060",marginBottom:"0.5rem"}}>
            {filteredProps.length} prop{filteredProps.length!==1?"s":""}
            {search&&` matching "${search}"`}
          </div>

          {/* Prop rows */}
          {filteredProps.map((prop, idx) => {
            // Find which game this prop belongs to
            const game = games.find(g=>g.gameID===prop.gameID);
            return (
              <div key={idx}
                onClick={() => onAnalyze(prop.playerName, prop.statType, prop.line, prop.position, game)}
                style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:8,
                  padding:"0.6rem 0.85rem",marginBottom:"0.3rem",cursor:"pointer",
                  display:"flex",justifyContent:"space-between",alignItems:"center",
                  transition:"border-color 0.12s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor="#1e3a5a"}
                onMouseLeave={e=>e.currentTarget.style.borderColor="#0e2040"}>

                <div>
                  <span style={{fontFamily:"'Black Han Sans',sans-serif",color:"#e8f4fd",
                    fontSize:"0.88rem",letterSpacing:"0.03em"}}>{prop.playerName}</span>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",color:"#2a4060",
                    fontSize:"0.58rem",marginLeft:"0.5rem"}}>{prop.away}@{prop.home}</span>
                </div>

                <div style={{display:"flex",alignItems:"center",gap:"0.6rem"}}>
                  <span style={{background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:4,
                    padding:"0.1rem 0.4rem",fontFamily:"'JetBrains Mono',monospace",
                    fontSize:"0.58rem",color:"#4a9eff"}}>{prop.statType}</span>
                  <span style={{fontFamily:"'Black Han Sans',sans-serif",color:"#e8f4fd",
                    fontSize:"1.1rem",minWidth:34,textAlign:"right"}}>{prop.line}</span>
                </div>
              </div>
            );
          })}

          {filteredProps.length === 0 && !loading && (
            <div style={{textAlign:"center",padding:"2rem",color:"#2a4060",
              fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem"}}>
              No props match your filters
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════
const EMPTY_FORM={playerName:"",statType:"Points",prop:"",
  l5Avg:"",l5Mpg:"",l5Med:"",l10Avg:"",l10Mpg:"",l10Med:"",l20Avg:"",l20Mpg:"",l20Med:"",
  l5OppAllowed:"",l10OppAllowed:"",l20OppAllowed:"",leagueAvgAllowed:"",
  h2hAvg:"",h2hGames:"",projMin:""};
const EMPTY_LOG={logs:[{min:"",stat:""},{min:"",stat:""},{min:"",stat:""}],h2hLogs:[],projMin:"",l5OppAllowed:"",l10OppAllowed:"",l20OppAllowed:"",leagueAvgAllowed:""};

export default function App(){
  const [mainTab,setMainTab]=useState("lab");       // lab | edge | history
  const [inputMode,setInputMode]=useState("summary"); // summary | gamelog
  const [form,setForm]=useState(EMPTY_FORM);
  const [logForm,setLogForm]=useState(EMPTY_LOG);
  const [done,setDone]=useState(false);
  const pendingAnalyzeRef = useRef(false); // set true by Edge Finder to trigger analyze after state settles
  const [history,setHistory]=useState([]);
  const [logSubTab,setLogSubTab]=useState("paste"); // paste | manual
  const [pasteParsedLogs,setPasteParsedLogs]=useState([]); // from paste parser
  const [pasteParsedH2H,setPasteParsedH2H]=useState([]);
  const [useRecency,setUseRecency]=useState(true);
  const [decayStrength,setDecayStrength]=useState(0.12);

  const [simIters,setSimIters]=useState(DEFAULT_ITERS);

  // result state
  const [model,setModel]=useState(null);         // summary/gamelog model output
  const [sim,setSim]=useState(null);             // {outcomes, simMean, ...}
  const [activePropLine,setActivePropLine]=useState(""); // editable in results
  const [projOverride,setProjOverride]=useState(""); // manual projection override
  const [minutesOverride,setMinutesOverride]=useState(null); // null = use model.pMin
  const simStats=sim&&activePropLine?calcSimStats(sim.outcomes,parseFloat(activePropLine)):null;

  // derived: if user overrides projection, recalc grade/rec against that
  // If minutesOverride is set and no projOverride, compute from blended rate * new minutes
  const effectiveProj = projOverride!=="" ? parseFloat(projOverride)
    : (minutesOverride!=null && model)
      ? (model.blendedRate??model.meanRate) * minutesOverride * (model.matchupFactor||1)
      : model?.projection;
  const activeDiff=effectiveProj&&activePropLine?effectiveProj-parseFloat(activePropLine):null;
  const activeDiffPct=activeDiff&&activePropLine?(activeDiff/parseFloat(activePropLine))*100:null;
  const activeStatType = inputMode==="summary" ? form.statType : (logForm.statType||"Points");
  const activeScore = (activeDiffPct!=null&&simStats) ? getEdgeScore({
    diffPct: activeDiffPct,
    overPct: simStats.overPct,
    boomPct: simStats.boomPct||0,
    bustPct: simStats.bustPct||0,
    minuteStability: model?.minuteStability??0.7,
    statType: activeStatType,
  }) : null;
  const activeGrade=activeScore; // kept for compat
  const activeRec=activeDiffPct!=null?getRec(activeDiffPct):null;

  useEffect(()=>{
    (()=>{ try{ const r=localStorage.getItem("pl-hist2"); if(r) setHistory(JSON.parse(r)); }catch{} })();
  },[]);
  const persist=(h)=>{ setHistory(h); try{ localStorage.setItem("pl-hist2",JSON.stringify(h)); }catch{} };

  const loadEntry=(e)=>{
    // Restore all input state
    setInputMode(e.inputMode||"summary");
    // Determine which sub-tab to show based on where data actually exists
    const hasPaste=(e.pasteParsedLogs||[]).some(r=>parseFloat(r.min)>0);
    const hasManual=(e.logForm?.logs||[]).some(r=>parseFloat(r.min)>0&&r.stat!=="");
    const resolvedSubTab = hasPaste?"paste":hasManual?"manual":(e.logSubTab||"paste");
    setLogSubTab(resolvedSubTab);
    if(e.form) setForm({...EMPTY_FORM,...e.form});
    if(e.logForm) setLogForm({...EMPTY_LOG,...e.logForm});
    if(e.pasteParsedLogs) setPasteParsedLogs(e.pasteParsedLogs);
    if(e.pasteParsedH2H)  setPasteParsedH2H(e.pasteParsedH2H);
    if(e.useRecency!==undefined) setUseRecency(e.useRecency);
    if(e.decayStrength)   setDecayStrength(e.decayStrength);
    if(e.simIters)        setSimIters(e.simIters);

    // Rebuild model and sim from saved inputs
    let m=null;
    try{
      if(e.inputMode==="summary"){
        m=buildSummaryModel({...EMPTY_FORM,...e.form});
      } else {
        // Determine best source for logs: paste parsed takes priority if non-empty,
        // then fall back to logForm.logs (manual entry)
        const pasteAvail=(e.pasteParsedLogs||[]).some(r=>parseFloat(r.min)>0);
        const manualAvail=(e.logForm?.logs||[]).some(r=>parseFloat(r.min)>0&&r.stat!=="");
        const srcLogs = pasteAvail ? (e.pasteParsedLogs||[])
                      : manualAvail ? (e.logForm?.logs||[])
                      : [];
        const srcH2H = (e.pasteParsedH2H||[]).some(r=>parseFloat(r.min)>0)
                      ? (e.pasteParsedH2H||[])
                      : (e.logForm?.h2hLogs||[]);
        const validLogs=srcLogs
          .map(r=>({min:parseFloat(r.min)||0,stat:parseFloat(r.stat)||0}))
          .filter(r=>r.min>0&&!isNaN(r.stat)&&r.stat>=0);
        const validH2H=srcH2H
          .map(r=>({min:parseFloat(r.min)||0,stat:parseFloat(r.stat)||0}))
          .filter(r=>r.min>0&&!isNaN(r.stat)&&r.stat>=0);
        const lf=e.logForm||{};
        m=buildGameLogModel({
          logs:validLogs, h2hLogs:validH2H,
          oppAllowed:lf.oppAllowed||0,
          oppTotalMin:lf.oppTotalMin||3936,
          statType:lf.statType||"Points",
          projMin:parseFloat(lf.projMin)||0,
          h2hAvg:"", h2hGames:"",
          useRecency:e.useRecency??true,
          decayStrength:e.decayStrength??0.12,
        });
      }
    } catch(err){ console.error("loadEntry model error",err); }

    if(!m) return;
    setModel(m);
    setProjOverride("");
    setMinutesOverride(null);
    const propLine=parseFloat(e.activePropLine)||0;
    setActivePropLine(String(propLine||""));
    const iters=e.simIters||DEFAULT_ITERS;
    const newSim=runMonteCarlo({
      meanRate:m.meanRate, sdRate:m.sdRate,
      meanMin:m.meanMin, sdMin:m.sdMin||m.meanMin*0.12,
      projMin:m.pMin, matchupFactor:m.matchupFactor,
      h2hMeanRate:m.h2hMeanRate, h2hBlendW:m.h2hBlendW,
      iters,
    });
    setSim(newSim);
    setDone(true);
    setMainTab("lab");
  };

  const setF=(k,v)=>setForm(f=>({...f,[k]:v}));
  const setLF=(k,v)=>setLogForm(f=>({...f,[k]:v}));

  // ── NBA API data loader ──
  const nba = useNBAData();
  const [gameLimit, setGameLimit] = useState(0);   // 0 = load all
  const [minFilter, setMinFilter] = useState(0);   // 0 = no filter, exclude games below this

  // ── DvP matchup auto-fill ──
  const dvp = useDvP();
  // shared opponent state so both summary and gamelog use same selection
  const [dvpOpp, setDvpOpp] = useState("");

  // Auto-fill handler for summary mode
  const handleDvpFillSummary = useCallback((vals) => {
    setForm(f => ({...f,
      l5OppAllowed:  vals.l5OppAllowed  || f.l5OppAllowed,
      l10OppAllowed: vals.l10OppAllowed || f.l10OppAllowed,
      l20OppAllowed: vals.l20OppAllowed || f.l20OppAllowed,
      leagueAvgAllowed: vals.leagueAvgAllowed || f.leagueAvgAllowed,
    }));
  }, []);

  // Auto-fill handler for game log mode
  const handleDvpFillLog = useCallback((vals) => {
    setLogForm(f => ({...f,
      l5OppAllowed:  vals.l5OppAllowed  || f.l5OppAllowed,
      l10OppAllowed: vals.l10OppAllowed || f.l10OppAllowed,
      l20OppAllowed: vals.l20OppAllowed || f.l20OppAllowed,
      leagueAvgAllowed: vals.leagueAvgAllowed || f.leagueAvgAllowed,
    }));
  }, []);

  // When user clicks "Load from NBA API"
  const handleNBALoad = async () => {
    const statType = logForm.statType || "Points";
    const data = await nba.loadData(nba.playerId, nba.playerName, statType);
    if (!data) return;

    // Apply game limit (0 = all games)
    const limit   = parseInt(gameLimit) || 0;
    const minMin  = parseFloat(minFilter) || 0;
    const allLogs = data.recent_logs || [];
    // Apply min filter first (remove injury/garbage time games)
    const filteredLogs = minMin > 0
      ? allLogs.filter(r => parseFloat(r.min) >= minMin)
      : allLogs;
    // Then apply game count limit
    const slicedLogs = limit > 0 ? filteredLogs.slice(0, limit) : filteredLogs;

    setPasteParsedLogs(slicedLogs);
    if (nba.opponent && data.h2h_logs) setPasteParsedH2H(data.h2h_logs);
    setLogSubTab("paste");

    // Recalculate window stats from sliced logs if limit applied
    const calcWindow = (logs, n) => {
      const w = logs.slice(0, n);
      if (!w.length) return null;
      const mins  = w.map(r => parseFloat(r.min) || 0);
      const stats = w.map(r => parseFloat(r.stat) || 0);
      const avg  = +(stats.reduce((a,b)=>a+b,0)/stats.length).toFixed(1);
      const mpg  = +(mins.reduce((a,b)=>a+b,0)/mins.length).toFixed(1);
      const med  = +([...stats].sort((a,b)=>a-b)[Math.floor(stats.length/2)]).toFixed(1);
      return { avg, mpg, median: med };
    };

    const l5  = calcWindow(slicedLogs, 5)  || data.l5;
    const l10 = calcWindow(slicedLogs, 10) || data.l10;
    const l20 = calcWindow(slicedLogs, 20) || data.l20;

    const updates = { playerName: nba.playerName };
    if (l5)  { updates.l5Avg  = String(l5.avg);  updates.l5Mpg  = String(l5.mpg);  updates.l5Med  = String(l5.median); }
    if (l10) { updates.l10Avg = String(l10.avg); updates.l10Mpg = String(l10.mpg); updates.l10Med = String(l10.median); }
    if (l20) { updates.l20Avg = String(l20.avg); updates.l20Mpg = String(l20.mpg); updates.l20Med = String(l20.median); }
    setLogForm(f => ({ ...f, ...updates }));
  };

  // rerun sim if projOverride changes (using new mean rate centered on override)
  useEffect(()=>{
    if(!model||!done) return;
    if(projOverride===""||isNaN(parseFloat(projOverride))) return;
    const newProj=parseFloat(projOverride);
    // adjust meanRate to match new projection while keeping same pMin
    const pMin=model.pMin||30;
    const newMeanRate=(newProj/pMin)/model.matchupFactor;
    const newSim=runMonteCarlo({
      meanRate:newMeanRate, sdRate:model.sdRate,
      meanMin:pMin, sdMin:model.sdMin||pMin*0.12,
      projMin:pMin, matchupFactor:model.matchupFactor,
      h2hMeanRate:model.h2hMeanRate, h2hBlendW:model.h2hBlendW,
      iters:simIters,
    });
    setSim(newSim);
  },[projOverride]);

  // rerun sim when minutesOverride changes
  useEffect(()=>{
    if(!model||!done||minutesOverride===null) return;
    const pMin = minutesOverride;
    // recalc projection from blended rate * new minutes * matchupFactor
    const newProj = model.blendedRate * pMin * model.matchupFactor;
    const newMeanRate = newProj / pMin / model.matchupFactor; // = blendedRate
    // Use blendedRate if available (gamelog model), else meanRate (summary model)
    const baseRate = model.blendedRate ?? model.meanRate;
    const newSim=runMonteCarlo({
      meanRate:baseRate, sdRate:model.sdRate,
      meanMin:model.meanMin, sdMin:model.sdMin||model.meanMin*0.12,
      projMin:pMin, matchupFactor:model.matchupFactor,
      h2hMeanRate:model.h2hMeanRate, h2hBlendW:model.h2hBlendW,
      iters:simIters,
    });
    setSim(newSim);
  },[minutesOverride]);

  const canGo = inputMode==="summary"
    ? (form.prop&&(form.l5Avg||form.l10Avg||form.l20Avg))
    : (logSubTab==="paste"
        ? pasteParsedLogs.length>0
        : logForm.logs.some(r=>parseFloat(r.min)>0&&parseFloat(r.stat)>=0&&r.stat!==""));

  // Fire analyze when Edge Finder has loaded everything and flagged pendingAnalyzeRef
  useEffect(()=>{
    if (pendingAnalyzeRef.current && pasteParsedLogs.length > 0 && !done) {
      pendingAnalyzeRef.current = false;
      // Small delay so React finishes rendering the new logs
      setTimeout(()=>{ handleAnalyze(); }, 100);
    }
  }, [pasteParsedLogs]);

  const handleAnalyze=()=>{
    let m;
    if(inputMode==="summary"){
      m=buildSummaryModel({...form, statType:form.statType||'Points'});
    } else {
      const srcLogs = logSubTab==="paste" ? pasteParsedLogs : logForm.logs;
      const srcH2H  = logSubTab==="paste" ? pasteParsedH2H  : (logForm.h2hLogs||[]);
      const validLogs=srcLogs.map(r=>({min:parseFloat(r.min)||0,stat:parseFloat(r.stat)||0})).filter(r=>r.min>0&&r.stat>=0);
      const validH2H=srcH2H.map(r=>({min:parseFloat(r.min)||0,stat:parseFloat(r.stat)||0})).filter(r=>r.min>0&&r.stat>=0);
      m=buildGameLogModel({
        logs:validLogs,
        h2hLogs:validH2H,
        l5OppAllowed:logForm.l5OppAllowed||"",
        l10OppAllowed:logForm.l10OppAllowed||"",
        l20OppAllowed:logForm.l20OppAllowed||"",
        leagueAvgAllowed:logForm.leagueAvgAllowed||"",
        statType:logForm.statType||"Points",
        projMin:parseFloat(logForm.projMin)||0,
        h2hAvg:"",
        h2hGames:"",
        useRecency,
        decayStrength,
      });
    }
    if(!m) return;
    setModel(m);
    setProjOverride("");
    setMinutesOverride(null);
    const propLine=inputMode==="summary"?parseFloat(form.prop):parseFloat(logForm.propLine||0);
    setActivePropLine(String(propLine||""));
    const newSim=runMonteCarlo({
      meanRate:m.meanRate, sdRate:m.sdRate,
      meanMin:m.meanMin, sdMin:m.sdMin||m.meanMin*0.12,
      projMin:m.pMin, matchupFactor:m.matchupFactor,
      h2hMeanRate:m.h2hMeanRate, h2hBlendW:m.h2hBlendW,
      iters:simIters,
    });
    setSim(newSim);
    setDone(true);
    window.scrollTo({top:0,behavior:'smooth'});
    // save history
    const ss=propLine?calcSimStats(newSim.outcomes,propLine):null;
    const diffPct=propLine?((m.projection-propLine)/propLine)*100:0;
    const {rec}=getRec(diffPct);
    const ss2=propLine?calcSimStats(newSim.outcomes,propLine):null;
    const histScore = ss2 ? getEdgeScore({
      diffPct, overPct:ss2.overPct, boomPct:ss2.boomPct||0, bustPct:ss2.bustPct||0,
      minuteStability:m?.minuteStability??0.7,
      statType: inputMode==="summary"?form.statType:(logForm.statType||"Points"),
    }) : 50;
    const entry={
      id:Date.now(),
      ts:new Date().toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}),
      // full input snapshot so we can reload later
      inputMode,
      logSubTab,
      form:{...form},
      logForm:{...logForm},
      pasteParsedLogs:[...pasteParsedLogs],
      pasteParsedH2H:[...pasteParsedH2H],
      useRecency,
      decayStrength,
      simIters,
      activePropLine:String(propLine||""),
      result:{projection:m.projection.toFixed(1),grade:histScore,recommendation:rec,simStats:ss},
    };
    persist([entry,...history].slice(0,50));
  };

  const S={background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,color:"#e8f4fd",padding:"0.55rem 0.75rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.95rem",width:"100%",outline:"none",boxSizing:"border-box"};
  const L={color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.78rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.3rem"};
  const SEC=(col="#4a9eff")=>({fontFamily:"'Black Han Sans',sans-serif",color:col,fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a"});

  // live projection preview while filling form
  const liveModel=inputMode==="summary"&&form.prop&&(form.l5Avg||form.l10Avg||form.l20Avg)
    ?buildSummaryModel({...form,statType:form.statType||'Points'}):null;

  const playerName=inputMode==="summary"?form.playerName:logForm.playerName;
  const statType=inputMode==="summary"?form.statType:logForm.statType||"Stat";

  return(
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Barlow+Condensed:wght@400;600;700;900&family=JetBrains+Mono:wght@400;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}body{background:#050d1a}input:focus,select:focus{border-color:#4a9eff!important;outline:none}input::placeholder{color:#2a4060}select option{background:#0a1628}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#050d1a}::-webkit-scrollbar-thumb{background:#1e3a5a;border-radius:3px}`}</style>
      <div style={{minHeight:"100vh",background:"#050d1a",padding:"1.5rem 1rem",fontFamily:"'Barlow Condensed',sans-serif"}}>
        <div style={{maxWidth:660,margin:"0 auto"}}>

          {/* ── HEADER ── */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1.5rem"}}>
            <div>
              <div style={{display:"flex",alignItems:"baseline",gap:"0.4rem"}}>
                <span style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"2rem",color:"#e8f4fd"}}>PROP</span>
                <span style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"2rem",color:"#4a9eff"}}>LAB</span>
                <span style={{background:"#ff6b00",color:"#fff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:900,fontSize:"0.6rem",letterSpacing:"0.15em",padding:"0.15em 0.5em",borderRadius:3,marginLeft:"0.2rem",verticalAlign:"super"}}>NBA</span>
              </div>
              <p style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.68rem",letterSpacing:"0.05em"}}>STAT/MIN · MONTE CARLO · GAME LOG ENGINE</p>
            </div>
            <div style={{display:"flex",background:"#080f1e",border:"1px solid #0e2040",borderRadius:8,overflow:"hidden"}}>
              {[["lab","🔬 Lab"],["edge","⚡ Edge"],["history",`📋 Hist${history.length?` (${history.length})`:""}`]].map(([t,label])=>(
                <button key={t} onClick={()=>setMainTab(t)} style={{padding:"0.5rem 0.9rem",background:mainTab===t?"#4a9eff":"transparent",color:mainTab===t?"#050d1a":"#3a6080",border:"none",fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.72rem",letterSpacing:"0.1em",textTransform:"uppercase",cursor:"pointer",transition:"all 0.15s"}}>{label}</button>
              ))}
            </div>
          </div>

          {/* ══════════════ LAB ══════════════ */}
          {mainTab==="lab"&&(
            <>
              {!done&&(
                <div>
                  {/* input mode switcher */}
                  <div style={{display:"flex",background:"#080f1e",border:"1px solid #0e2040",borderRadius:8,overflow:"hidden",marginBottom:"1rem"}}>
                    {[["summary","📊 Summary (L5/L10/L20)"],["gamelog","📋 Game Logs"]].map(([m,label])=>(
                      <button key={m} onClick={()=>setInputMode(m)} style={{flex:1,padding:"0.6rem",background:inputMode===m?"#1e3a5a":"transparent",color:inputMode===m?"#4a9eff":"#3a6080",border:"none",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.82rem",letterSpacing:"0.08em",cursor:"pointer",transition:"all 0.15s"}}>{label}</button>
                    ))}
                  </div>

                  <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.5rem",marginBottom:"1rem"}}>

                    {/* ── SUMMARY INPUT ── */}
                    {inputMode==="summary"&&(
                      <>
                        <div style={SEC()}>Player & Prop</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1rem"}}>
                          <div><label style={L}>Player Name</label><input style={S} placeholder="e.g. LeBron James" value={form.playerName} onChange={e=>setF("playerName",e.target.value)}/></div>
                          <div><label style={L}>Stat Type</label><select style={{...S,cursor:"pointer"}} value={form.statType} onChange={e=>setF("statType",e.target.value)}>{STAT_TYPES.map(s=><option key={s}>{s}</option>)}</select></div>
                        </div>
                        <div style={{marginBottom:"1.5rem"}}>
                          <label style={L}>Prop Line</label>
                          <div style={{display:"flex",gap:"0.75rem",alignItems:"center"}}>
                            <input style={{...S,fontSize:"1.4rem",fontWeight:600,padding:"0.65rem 0.75rem"}} placeholder="25.5" type="number" step="0.5" value={form.prop} onChange={e=>setF("prop",e.target.value)}/>
                            {liveModel&&(
                              <div style={{background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.5rem 0.9rem",textAlign:"center",minWidth:80,flexShrink:0}}>
                                <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem"}}>PROJ</div>
                                <div style={{color:"#4a9eff",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.5rem",lineHeight:1}}>{liveModel.projection.toFixed(1)}</div>
                              </div>
                            )}
                          </div>
                        </div>

                        <div style={SEC()}>Player Averages (per window)</div>
                        <div style={{display:"grid",gridTemplateColumns:"44px 1fr 1fr 1fr",gap:"0.4rem 0.6rem",alignItems:"end",marginBottom:"1.5rem"}}>
                          <div/>
                          <div style={{...L,textAlign:"center"}}>Avg</div>
                          <div style={{...L,textAlign:"center"}}>Median <span style={{color:"#2a4060",fontSize:"0.6rem"}}>(opt)</span></div>
                          <div style={{...L,textAlign:"center"}}>MPG</div>
                          {[["L5","l5Avg","l5Med","l5Mpg"],["L10","l10Avg","l10Med","l10Mpg"],["L20","l20Avg","l20Med","l20Mpg"]].map(([lbl,ak,mdk,mk])=>(
                            <>{/* */}
                              <span key={lbl} style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"1rem",paddingBottom:"0.55rem"}}>{lbl}</span>
                              <input key={ak} style={S} placeholder="29.0" type="number" step="0.1" value={form[ak]} onChange={e=>setF(ak,e.target.value)}/>
                              <input key={mdk} style={{...S,borderColor:"#1a3050"}} placeholder="27.0" type="number" step="0.1" value={form[mdk]} onChange={e=>setF(mdk,e.target.value)}/>
                              <input key={mk} style={S} placeholder="25" type="number" step="0.1" value={form[mk]} onChange={e=>setF(mk,e.target.value)}/>
                            </>
                          ))}
                        </div>

                        <div style={SEC()}>Opponent Matchup <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(optional)</span></div>
                        <DvPPanel
                          statType={form.statType||"Points"}
                          dvp={dvp}
                          currentOpp={dvpOpp}
                          onOppChange={setDvpOpp}
                          onFill={handleDvpFillSummary}
                        />
                        <div style={{background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.9rem",marginBottom:"1.5rem"}}>
                          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",marginBottom:"0.65rem"}}>
                            Auto-filled from DvP sheet · all values are per-game averages · edit freely.
                          </div>
                          {/* L5/L10/L20 opp allowed grid */}
                          <div style={{display:"grid",gridTemplateColumns:"44px 1fr 1fr",gap:"0.4rem 0.75rem",alignItems:"end",marginBottom:"0.75rem"}}>
                            <div/>
                            <div style={{...L,textAlign:"center",color:"#3a6080"}}>Opp Avg/Game ({form.statType})</div>
                            <div style={{...L,textAlign:"center",color:"#3a6080"}}>Rate (/game)</div>
                            {[["L5","l5OppAllowed"],["L10","l10OppAllowed"],["L20","l20OppAllowed"]].map(([lbl,k])=>{
                              const v=parseFloat(form[k])||0;
                              const rate=v>0?v.toFixed(2):null;
                              return(<>
                                <span key={lbl} style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"1rem",paddingBottom:"0.55rem"}}>{lbl}</span>
                                <input key={k} style={S} placeholder="e.g. 32.4" type="number" step="0.1" value={form[k]} onChange={e=>setF(k,e.target.value)}/>
                                <div key={k+"r"} style={{background:"#0a1628",borderRadius:6,padding:"0.55rem 0.5rem",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem",color:rate?"#ffee58":"#2a4060"}}>
                                  {rate||"—"}
                                </div>
                              </>);
                            })}
                          </div>
                          <div>
                            <label style={{...L,color:"#3a6080"}}>League Avg Allowed (same span/position) <span style={{color:"#2a4060",fontWeight:400}}>(opt)</span></label>
                            <div style={{display:"flex",gap:"0.75rem",alignItems:"center"}}>
                              <input style={{...S,flexShrink:0}} placeholder="e.g. 28.5" type="number" step="0.1" value={form.leagueAvgAllowed} onChange={e=>setF("leagueAvgAllowed",e.target.value)}/>
                              {form.leagueAvgAllowed&&parseFloat(form.leagueAvgAllowed)>0&&(
                                <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",whiteSpace:"nowrap"}}>{parseFloat(form.leagueAvgAllowed).toFixed(2)}/game</span>
                              )}
                            </div>
                          </div>
                          {/* Live matchup label */}
                          {(form.l5OppAllowed||form.l10OppAllowed||form.l20OppAllowed)&&form.leagueAvgAllowed&&(()=>{
                            const oppVals=[{v:parseFloat(form.l5OppAllowed)||0,w:0.5},{v:parseFloat(form.l10OppAllowed)||0,w:0.3},{v:parseFloat(form.l20OppAllowed)||0,w:0.2}].filter(x=>x.v>0);
                            if(!oppVals.length) return null;
                            const tw=oppVals.reduce((a,b)=>a+b.w,0);
                            const wOpp=oppVals.reduce((a,b)=>a+b.v*(b.w/tw),0);
                            const ratio=wOpp/(parseFloat(form.leagueAvgAllowed)||1);
                            const col=ratio>1.05?"#00e676":ratio<0.95?"#ff7043":"#ffee58";
                            const lbl=ratio>1.05?"🟢 EASY MATCHUP":ratio<0.95?"🔴 TOUGH MATCHUP":"🟡 NEUTRAL";
                            return <div style={{marginTop:"0.6rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span style={{color:col,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.8rem",letterSpacing:"0.05em"}}>{lbl}</span>
                              <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>ratio {ratio.toFixed(2)}×</span>
                            </div>;
                          })()}
                        </div>
                        {/* H2H summary */}                        {/* H2H summary */}
                        <div style={{...SEC("#ff9800")}}>H2H vs This Opponent <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(optional)</span></div>
                        <div style={{background:"#050d1a",border:"1px solid #1a2a0a",borderRadius:8,padding:"1rem",marginBottom:"1.5rem"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"0.75rem"}}>
                            <div><label style={{...L,color:"#ff9800"}}>H2H Avg</label><input style={{...S,borderColor:"#2a3a1a"}} placeholder="22.0" type="number" step="0.1" value={form.h2hAvg} onChange={e=>setF("h2hAvg",e.target.value)}/></div>
                            <div><label style={{...L,color:"#ff9800"}}># H2H Games</label><input style={{...S,borderColor:"#2a3a1a"}} placeholder="3" type="number" min="1" value={form.h2hGames} onChange={e=>setF("h2hGames",e.target.value)}/></div>
                          </div>
                          {form.h2hGames&&parseInt(form.h2hGames)>0&&<H2HBar games={parseInt(form.h2hGames)}/>}
                        </div>

                        <div style={SEC()}>Tonight</div>
                        <div style={{marginBottom:"1.5rem"}}>
                          <label style={L}>Projected Minutes</label>
                          <input style={{...S,fontSize:"1.2rem"}} placeholder="32" type="number" step="0.5" value={form.projMin} onChange={e=>setF("projMin",e.target.value)}/>
                        </div>
                      </>
                    )}

                    {/* ── RECENCY WEIGHTING (game log mode only) ── */}
                    {inputMode==="gamelog"&&(
                      <div style={{marginBottom:"1.25rem",background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.9rem 1rem"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:useRecency?"0.75rem":0}}>
                          <div>
                            <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#e8f4fd",fontSize:"0.72rem",letterSpacing:"0.15em",textTransform:"uppercase"}}>Recency Weighting</div>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.15rem"}}>Recent games count more toward projection</div>
                          </div>
                          {/* Toggle */}
                          <div onClick={()=>setUseRecency(v=>!v)} style={{cursor:"pointer",width:44,height:24,background:useRecency?"#4a9eff":"#1e3a5a",borderRadius:12,position:"relative",transition:"background 0.2s",flexShrink:0}}>
                            <div style={{position:"absolute",top:3,left:useRecency?23:3,width:18,height:18,background:useRecency?"#050d1a":"#3a6080",borderRadius:"50%",transition:"left 0.2s"}}/>
                          </div>
                        </div>
                        {useRecency&&(
                          <div>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.35rem"}}>
                              <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",letterSpacing:"0.06em"}}>DECAY STRENGTH</span>
                              <span style={{color:"#4a9eff",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.72rem",fontWeight:600}}>{decayStrength.toFixed(2)}</span>
                            </div>
                            <input type="range" min="0.05" max="0.20" step="0.01"
                              value={decayStrength}
                              onChange={e=>setDecayStrength(parseFloat(e.target.value))}
                              style={{width:"100%",accentColor:"#4a9eff",cursor:"pointer"}}
                            />
                            <div style={{display:"flex",justifyContent:"space-between",marginTop:"0.2rem"}}>
                              <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>0.05 subtle</span>
                              <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>0.20 aggressive</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── SIM COUNT SELECTOR (both modes) ── */}
                    <div style={{marginBottom:"1.25rem"}}>
                      <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#3a6080",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.6rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <span>Monte Carlo Simulations</span>
                        <span style={{color:"#4a9eff",fontSize:"0.9rem"}}>{simIters.toLocaleString()}</span>
                      </div>
                      <div style={{display:"flex",gap:"0.4rem"}}>
                        {SIM_PRESETS.map(n=>(
                          <button key={n} onClick={()=>setSimIters(n)} style={{flex:1,padding:"0.4rem 0",background:simIters===n?"#4a9eff":"#0a1628",color:simIters===n?"#050d1a":"#3a6080",border:`1px solid ${simIters===n?"#4a9eff":"#1e3a5a"}`,borderRadius:6,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",cursor:"pointer",transition:"all 0.15s"}}>
                            {n>=1000?`${n/1000}k`:n}
                          </button>
                        ))}
                      </div>
                      <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.4rem"}}>Higher = more accurate tails · slower run · 10k is a good default</div>
                    </div>

                    {/* ── GAME LOG INPUT ── */}
                    {inputMode==="gamelog"&&(
                      <>
                        <div style={SEC()}>Player Info</div>

                        {/* Stat Type row */}
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1rem"}}>
                          <div><label style={L}>Stat Type</label><select style={{...S,cursor:"pointer"}} value={logForm.statType||"Points"} onChange={e=>setLF("statType",e.target.value)}>{STAT_TYPES.map(s=><option key={s}>{s}</option>)}</select></div>
                          <div><label style={L}>Player Name</label><input style={S} placeholder="or type manually" value={logForm.playerName||""} onChange={e=>setLF("playerName",e.target.value)}/></div>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1.5rem"}}>
                          <div>
                            <label style={L}>Prop Line</label>
                            <input style={{...S,fontSize:"1.2rem",fontWeight:600}} placeholder="34.5" type="number" step="0.5" value={logForm.propLine||""} onChange={e=>setLF("propLine",e.target.value)}/>
                          </div>
                          <div>
                            <label style={L}>Proj Minutes Tonight</label>
                            <input style={S} placeholder="34" type="number" step="0.5" value={logForm.projMin} onChange={e=>setLF("projMin",e.target.value)}/>
                          </div>
                        </div>

                        {/* NBA API loader panel */}
                        <div style={{background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.9rem 1rem",marginBottom:"1.25rem"}}>
                          <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.68rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem"}}>
                            Auto-Load from NBA API
                          </div>

                          {/* Player search + season */}
                          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"0.75rem",marginBottom:"0.65rem",alignItems:"end"}}>
                            <div>
                              <label style={L}>Player</label>
                              <PlayerSearch
                                value={nba.playerName}
                                onSelect={(id, name) => {
                                  nba.setPlayerId(id);
                                  nba.setPlayerName(name||"");
                                  nba.setLoaded(false);
                                  if(name) setLF("playerName", name);
                                }}
                              />
                            </div>
                            <div>
                              <label style={L}>Season</label>
                              <select style={{...S,width:"auto",minWidth:100,cursor:"pointer"}}
                                value={nba.season} onChange={e=>nba.setSeason(e.target.value)}>
                                {(Array.isArray(nba.seasons)?nba.seasons:[]).map(s=><option key={s}>{s}</option>)}
                              </select>
                            </div>
                          </div>

                          {/* Opponent filter */}
                          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"0.75rem",marginBottom:"0.75rem",alignItems:"end"}}>
                            <div>
                              <label style={{...L,color:"#ff9800"}}>H2H Opponent Filter <span style={{color:"#3a6080",fontWeight:400}}>(optional)</span></label>
                              <select style={{...S,cursor:"pointer",borderColor:"#2a3a1a"}}
                                value={nba.opponent} onChange={e=>nba.setOpponent(e.target.value)}>
                                <option value="">— All games —</option>
                                {nba.opponents.length>0
                                  ? nba.opponents.map(o=><option key={o} value={o}>{o}</option>)
                                  : ["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW",
                                     "HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK",
                                     "OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"
                                    ].map(o=><option key={o} value={o}>{o}</option>)
                                }
                              </select>
                            </div>
                            <div>
                              <button
                                onClick={handleNBALoad}
                                disabled={!nba.playerId||nba.loading}
                                style={{
                                  padding:"0.55rem 1rem",
                                  background:nba.playerId&&!nba.loading?"#4a9eff":"#1e3a5a",
                                  color:nba.playerId&&!nba.loading?"#050d1a":"#2a4060",
                                  border:"none",borderRadius:6,
                                  fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.8rem",
                                  letterSpacing:"0.08em",cursor:nba.playerId?"pointer":"not-allowed",
                                  whiteSpace:"nowrap",
                                }}>
                                {nba.loading?"Loading…":"⬇ Load"}
                              </button>
                            </div>
                          </div>

                          {/* Status messages */}
                          {nba.error&&(
                            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.68rem",
                              padding:"0.65rem 0.75rem",background:"#1a0a08",borderRadius:6,border:"1px solid #3a1a10",lineHeight:1.7}}>
                              {(nba.error.includes("401")||nba.error.toLowerCase().includes("bdl_api_key")||nba.error.toLowerCase().includes("api key"))?(
                                <div>
                                  <div style={{color:"#ffee58",fontWeight:600,marginBottom:"0.4rem"}}>⚠ API Key Required</div>
                                  <div style={{color:"#ff9060"}}>
                                    1. Go to <span style={{color:"#4a9eff"}}>balldontlie.io</span> → Sign Up (free)<br/>
                                    2. Copy your API key from the dashboard<br/>
                                    3. In Railway → your service → <span style={{color:"#4a9eff"}}>Variables</span><br/>
                                    4. Add: <span style={{color:"#00e676"}}>BDL_API_KEY</span> = your key<br/>
                                    5. Railway redeploys automatically ✓
                                  </div>
                                </div>
                              ):(
                                <div style={{color:"#ff7043"}}>
                                  ⚠ {nba.error}
                                  {(nba.error.toLowerCase().includes("timeout")||nba.error.toLowerCase().includes("timed out"))&&(
                                    <div style={{color:"#ffee58",marginTop:"0.3rem"}}>Click ⬇ Load again to retry.</div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Filters row: min minutes + game limit */}
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.65rem",marginTop:"0.65rem"}}>
                            <div>
                              <label style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.25rem"}}>
                                Min Minutes Filter
                              </label>
                              <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}>
                                <input
                                  type="number" min="0" max="48" step="1"
                                  placeholder="Off"
                                  value={minFilter||""}
                                  onChange={e=>setMinFilter(parseFloat(e.target.value)||0)}
                                  style={{background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,color:"#e8f4fd",padding:"0.5rem 0.65rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.9rem",width:"100%",outline:"none"}}
                                />
                                {minFilter>0&&(
                                  <button onClick={()=>setMinFilter(0)}
                                    style={{background:"none",border:"none",color:"#3a6080",cursor:"pointer",fontSize:"0.9rem",padding:"0.2rem",flexShrink:0}}>✕</button>
                                )}
                              </div>
                              <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",marginTop:"0.2rem"}}>
                                {minFilter>0?`Excluding games under ${minFilter} min`:"Keeping all games"}
                              </div>
                              <div style={{display:"flex",gap:"0.3rem",marginTop:"0.35rem",flexWrap:"wrap"}}>
                                {[10,15,20,25].map(n=>(
                                  <button key={n} onClick={()=>setMinFilter(n)}
                                    style={{padding:"0.3rem 0.5rem",background:minFilter===n?"#4a9eff":"#0a1628",color:minFilter===n?"#050d1a":"#3a6080",border:`1px solid ${minFilter===n?"#4a9eff":"#1e3a5a"}`,borderRadius:5,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",cursor:"pointer"}}>
                                    {n}+
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div>
                              <label style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:"0.25rem"}}>
                                Load Last N Games
                              </label>
                              <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}>
                                <input
                                  type="number" min="0" max="82" step="1"
                                  placeholder="All"
                                  value={gameLimit||""}
                                  onChange={e=>setGameLimit(parseInt(e.target.value)||0)}
                                  style={{background:"#0a1628",border:"1px solid #1e3a5a",borderRadius:6,color:"#e8f4fd",padding:"0.5rem 0.65rem",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.9rem",width:"100%",outline:"none"}}
                                />
                                {gameLimit>0&&(
                                  <button onClick={()=>setGameLimit(0)}
                                    style={{background:"none",border:"none",color:"#3a6080",cursor:"pointer",fontSize:"0.9rem",padding:"0.2rem",flexShrink:0}}>✕</button>
                                )}
                              </div>
                              <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",marginTop:"0.2rem"}}>
                                {gameLimit>0?`Loading last ${gameLimit} games`:"Loading all games this season"}
                              </div>
                            </div>
                            <div style={{display:"flex",alignItems:"flex-end"}}>
                              <div style={{display:"flex",gap:"0.3rem",flexWrap:"wrap"}}>
                                {[5,10,15,20].map(n=>(
                                  <button key={n} onClick={()=>setGameLimit(n)}
                                    style={{padding:"0.35rem 0.6rem",background:gameLimit===n?"#4a9eff":"#0a1628",color:gameLimit===n?"#050d1a":"#3a6080",border:`1px solid ${gameLimit===n?"#4a9eff":"#1e3a5a"}`,borderRadius:5,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.68rem",cursor:"pointer"}}>
                                    L{n}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          {nba.loaded&&!nba.error&&(
                            <div style={{marginTop:"0.5rem"}}>
                              <div style={{color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",
                                padding:"0.4rem 0.6rem",background:"#0a1a0a",borderRadius:5,border:"1px solid #1a3a1a",marginBottom:"0.5rem"}}>
                                ✓ {pasteParsedLogs.length} games loaded for {nba.playerName}
                                {gameLimit>0&&` (last ${gameLimit})`}
                                {minFilter>0&&` · ${minFilter}+ min only`}
                                {pasteParsedH2H.length>0&&` · ${pasteParsedH2H.length} H2H vs ${nba.opponent}`}
                                {" · "}
                                <span style={{color:"#3a8060"}}>edit any values below before analyzing</span>
                              </div>
                              <ParsedPreview
                                rows={pasteParsedLogs}
                                label="LOADED GAMES"
                                statType={logForm.statType||"Points"}
                                useRecency={useRecency}
                                decayStrength={decayStrength}
                              />
                              {pasteParsedH2H.length>0&&(
                                <div style={{marginTop:"0.5rem"}}>
                                  <ParsedPreview
                                    rows={pasteParsedH2H}
                                    label="H2H GAMES"
                                    statType={logForm.statType||"Points"}
                                    useRecency={useRecency}
                                    decayStrength={decayStrength}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* paste / manual sub-tab switcher */}
                        <div style={{display:"flex",background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,overflow:"hidden",marginBottom:"1.25rem"}}>
                          {[["paste","📋 Paste Raw Text"],["manual","✏️ Manual Entry"]].map(([m,lbl])=>(
                            <button key={m} onClick={()=>setLogSubTab(m)} style={{flex:1,padding:"0.5rem 0",background:logSubTab===m?"#1e3a5a":"transparent",color:logSubTab===m?"#4a9eff":"#3a6080",border:"none",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"0.8rem",letterSpacing:"0.08em",cursor:"pointer",transition:"all 0.15s"}}>{lbl}</button>
                          ))}
                        </div>

                        {/* PASTE MODE */}
                        {logSubTab==="paste"&&(
                          <>
                            <PasteLogPanel
                              statType={logForm.statType||"Points"}
                              onParsed={rows=>{setPasteParsedLogs(rows);}}
                              onH2HParsed={rows=>{setPasteParsedH2H(rows);}}
                              useRecency={useRecency}
                              decayStrength={decayStrength}
                            />
                            {pasteParsedLogs.length>0&&(
                              <div style={{marginTop:"0.5rem",color:"#00e676",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",textAlign:"center"}}>
                                ✓ {pasteParsedLogs.length} games ready · {pasteParsedH2H.length>0?`${pasteParsedH2H.length} H2H games ready`:"no H2H"}
                              </div>
                            )}
                            <div style={{marginTop:"1.25rem",marginBottom:"1rem"}}>
                              <div style={SEC()}>Opponent Matchup <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(optional)</span></div>
                              <DvPPanel
                                statType={logForm.statType||"Points"}
                                dvp={dvp}
                                currentOpp={dvpOpp}
                                onOppChange={setDvpOpp}
                                onFill={handleDvpFillLog}
                              />
                              <div style={{background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.75rem"}}>
                                <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginBottom:"0.65rem"}}>
                                  Auto-filled from DvP sheet · all values are per-game averages · edit freely
                                </div>
                                <div style={{display:"grid",gridTemplateColumns:"44px 1fr 1fr",gap:"0.4rem 0.75rem",alignItems:"end",marginBottom:"0.75rem"}}>
                                  <div/>
                                  <div style={{...L,textAlign:"center",color:"#3a6080"}}>Opp Avg/Game</div>
                                  <div style={{...L,textAlign:"center",color:"#3a6080"}}>Rate (/game)</div>
                                  {[["L5","l5OppAllowed"],["L10","l10OppAllowed"],["L20","l20OppAllowed"]].map(([lbl,k])=>{
                                    const v=parseFloat(logForm[k])||0;
                                    const rate=v>0?v.toFixed(2):null;
                                    return(<>
                                      <span key={lbl} style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"1rem",paddingBottom:"0.55rem"}}>{lbl}</span>
                                      <input key={k} style={S} placeholder="e.g. 32.4" type="number" step="0.1" value={logForm[k]||""} onChange={e=>setLF(k,e.target.value)}/>
                                      <div key={k+"r"} style={{background:"#0a1628",borderRadius:6,padding:"0.55rem 0.5rem",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem",color:rate?"#ffee58":"#2a4060"}}>{rate||"—"}</div>
                                    </>);
                                  })}
                                </div>
                                <div>
                                  <label style={{...L,color:"#3a6080"}}>League Avg Allowed (same span)</label>
                                  <div style={{display:"flex",gap:"0.75rem",alignItems:"center"}}>
                                    <input style={{...S,flexShrink:0}} placeholder="e.g. 28.5" type="number" step="0.1" value={logForm.leagueAvgAllowed||""} onChange={e=>setLF("leagueAvgAllowed",e.target.value)}/>
                                    {logForm.leagueAvgAllowed&&parseFloat(logForm.leagueAvgAllowed)>0&&(
                                      <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",whiteSpace:"nowrap"}}>{parseFloat(logForm.leagueAvgAllowed).toFixed(2)}/game avg</span>
                                    )}
                                  </div>
                                </div>
                                {(logForm.l5OppAllowed||logForm.l10OppAllowed||logForm.l20OppAllowed)&&logForm.leagueAvgAllowed&&(()=>{
                                  const ov=[{v:parseFloat(logForm.l5OppAllowed)||0,w:0.5},{v:parseFloat(logForm.l10OppAllowed)||0,w:0.3},{v:parseFloat(logForm.l20OppAllowed)||0,w:0.2}].filter(x=>x.v>0);
                                  const tw=ov.reduce((a,b)=>a+b.w,0)||1;
                                  const wOpp=ov.reduce((a,b)=>a+b.v*(b.w/tw),0);
                                  const ratio=wOpp/(parseFloat(logForm.leagueAvgAllowed)||1);
                                  const col=ratio>1.05?"#00e676":ratio<0.95?"#ff7043":"#ffee58";
                                  const lbl=ratio>1.05?"🟢 EASY MATCHUP":ratio<0.95?"🔴 TOUGH MATCHUP":"🟡 NEUTRAL";
                                  return <div style={{marginTop:"0.6rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                                    <span style={{color:col,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.8rem"}}>{lbl}</span>
                                    <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>ratio {ratio.toFixed(2)}×</span>
                                  </div>;
                                })()}
                              </div>
                            </div>
                          </>
                        )}

                        {/* MANUAL MODE */}
                        {logSubTab==="manual"&&(
                          <>
                            <div style={SEC()}>Recent Game Logs <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(newest first)</span></div>
                            <div style={{marginBottom:"1.5rem"}}>
                              <GameLogEditor logs={logForm.logs} onChange={v=>setLF("logs",v)}/>
                            </div>

                            <div style={SEC()}>Opponent Matchup <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(optional)</span></div>
                            <DvPPanel
                              statType={logForm.statType||"Points"}
                              dvp={dvp}
                              currentOpp={dvpOpp}
                              onOppChange={setDvpOpp}
                              onFill={handleDvpFillLog}
                            />
                            <div style={{background:"#050d1a",border:"1px solid #1e3a5a",borderRadius:8,padding:"0.75rem",marginBottom:"1.5rem"}}>
                              <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginBottom:"0.65rem"}}>
                                Auto-filled from DvP sheet · all values are per-game averages · edit freely
                              </div>
                              <div style={{display:"grid",gridTemplateColumns:"44px 1fr 1fr",gap:"0.4rem 0.75rem",alignItems:"end",marginBottom:"0.75rem"}}>
                                <div/>
                                <div style={{...L,textAlign:"center",color:"#3a6080"}}>Opp Avg/Game</div>
                                <div style={{...L,textAlign:"center",color:"#3a6080"}}>Rate (/game)</div>
                                {[["L5","l5OppAllowed"],["L10","l10OppAllowed"],["L20","l20OppAllowed"]].map(([lbl,k])=>{
                                  const v=parseFloat(logForm[k])||0;
                                  const rate=v>0?v.toFixed(2):null;
                                  return(<>
                                    <span key={lbl} style={{color:"#4a9eff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:"1rem",paddingBottom:"0.55rem"}}>{lbl}</span>
                                    <input key={k} style={S} placeholder="e.g. 32.4" type="number" step="0.1" value={logForm[k]||""} onChange={e=>setLF(k,e.target.value)}/>
                                    <div key={k+"r"} style={{background:"#0a1628",borderRadius:6,padding:"0.55rem 0.5rem",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem",color:rate?"#ffee58":"#2a4060"}}>{rate||"—"}</div>
                                  </>);
                                })}
                              </div>
                              <div>
                                <label style={{...L,color:"#3a6080"}}>League Avg Allowed (same span)</label>
                                <div style={{display:"flex",gap:"0.75rem",alignItems:"center"}}>
                                  <input style={{...S,flexShrink:0}} placeholder="e.g. 28.5" type="number" step="0.1" value={logForm.leagueAvgAllowed||""} onChange={e=>setLF("leagueAvgAllowed",e.target.value)}/>
                                  {logForm.leagueAvgAllowed&&parseFloat(logForm.leagueAvgAllowed)>0&&(
                                    <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",whiteSpace:"nowrap"}}>{parseFloat(logForm.leagueAvgAllowed).toFixed(2)}/game avg</span>
                                  )}
                                </div>
                              </div>
                              {(logForm.l5OppAllowed||logForm.l10OppAllowed||logForm.l20OppAllowed)&&logForm.leagueAvgAllowed&&(()=>{
                                const ov=[{v:parseFloat(logForm.l5OppAllowed)||0,w:0.5},{v:parseFloat(logForm.l10OppAllowed)||0,w:0.3},{v:parseFloat(logForm.l20OppAllowed)||0,w:0.2}].filter(x=>x.v>0);
                                const tw=ov.reduce((a,b)=>a+b.w,0)||1;
                                const wOpp=ov.reduce((a,b)=>a+b.v*(b.w/tw),0);
                                const ratio=wOpp/(parseFloat(logForm.leagueAvgAllowed)||1);
                                const col=ratio>1.05?"#00e676":ratio<0.95?"#ff7043":"#ffee58";
                                const lbl=ratio>1.05?"🟢 EASY MATCHUP":ratio<0.95?"🔴 TOUGH MATCHUP":"🟡 NEUTRAL";
                                return <div style={{marginTop:"0.6rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                                  <span style={{color:col,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.8rem"}}>{lbl}</span>
                                  <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>ratio {ratio.toFixed(2)}×</span>
                                </div>;
                              })()}
                            </div>

                            <div style={{...SEC("#ff9800")}}>H2H Game Logs vs This Opponent <span style={{color:"#3a6080",fontWeight:400,fontSize:"0.7rem"}}>(optional)</span></div>
                            <div style={{background:"#050d1a",border:"1px solid #1a2a0a",borderRadius:8,padding:"1rem",marginBottom:"1.5rem"}}>
                              <GameLogEditor logs={logForm.h2hLogs||[]} onChange={v=>setLF("h2hLogs",v)}/>
                              {logForm.h2hLogs&&logForm.h2hLogs.filter(r=>r.min&&r.stat).length>0&&(
                                <div style={{marginTop:"0.75rem"}}>
                                  <H2HBar games={logForm.h2hLogs.filter(r=>r.min&&r.stat).length}/>
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </>
                    )}

                    <button data-analyze onClick={handleAnalyze} disabled={!canGo} style={{width:"100%",padding:"0.9rem",background:canGo?"#4a9eff":"#1e3a5a",color:canGo?"#050d1a":"#2a4060",border:"none",borderRadius:8,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.1rem",letterSpacing:"0.1em",cursor:canGo?"pointer":"not-allowed",transition:"all 0.2s",boxShadow:canGo?"0 0 20px #4a9eff40":"none"}}>
                      ANALYZE PROP →
                    </button>
                  </div>
                </div>
              )}

              {/* ══ RESULTS ══ */}
              {done&&model&&(
                <div>
                  {/* MAIN CARD */}
                  <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.5rem",marginBottom:"1rem"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"1.25rem"}}>
                      <div>
                        {playerName&&<div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.5rem",color:"#e8f4fd",marginBottom:"0.2rem"}}>{playerName.toUpperCase()}</div>}
                        <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.8rem"}}>{statType.toUpperCase()} · LINE: <span style={{color:"#4a9eff"}}>{activePropLine}</span></div>
                      </div>
                      {activeScore!=null&&<ScoreBadge score={activeScore}/>}
                    </div>

                    {/* Editable projection + prop line */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1rem"}}>
                      <div style={{background:"#0a1628",borderRadius:8,padding:"0.9rem"}}>
                        <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em",marginBottom:"0.35rem"}}>PROJECTION <span style={{color:"#2a4060"}}>(tap to override)</span></div>
                        <input
                          style={{background:"transparent",border:"none",borderBottom:"1px solid #1e3a5a",color:"#e8f4fd",fontFamily:"'Black Han Sans',sans-serif",fontSize:"2.2rem",lineHeight:1,width:"100%",outline:"none",padding:"0 0 0.2rem"}}
                          type="number" step="0.1"
                          value={projOverride!==""?projOverride:effectiveProj!=null?effectiveProj.toFixed(1):model.projection.toFixed(1)}
                          onChange={e=>{setProjOverride(e.target.value);setMinutesOverride(null);}}
                          onBlur={e=>{if(e.target.value==="")setProjOverride("");}}
                        />
                        {activeDiff!=null&&(
                          <div style={{color:activeDiff>=0?"#00e676":"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",marginTop:"0.3rem"}}>
                            {activeDiff>=0?"+":""}{activeDiff.toFixed(1)} ({activeDiffPct>=0?"+":""}{activeDiffPct.toFixed(1)}%)
                          </div>
                        )}
                      </div>
                      <div style={{background:"#0a1628",borderRadius:8,padding:"0.9rem"}}>
                        <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.1em",marginBottom:"0.35rem"}}>PROP LINE <span style={{color:"#2a4060"}}>(edit to update sim)</span></div>
                        <input
                          style={{background:"transparent",border:"none",borderBottom:"1px solid #1e3a5a",color:"#4a9eff",fontFamily:"'Black Han Sans',sans-serif",fontSize:"2.2rem",lineHeight:1,width:"100%",outline:"none",padding:"0 0 0.2rem"}}
                          type="number" step="0.5"
                          value={activePropLine}
                          onChange={e=>setActivePropLine(e.target.value)}
                        />
                        {activeRec&&<div style={{color:activeRec.color,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.1rem",marginTop:"0.35rem"}}>{activeRec.rec}</div>}
                      </div>
                    </div>

                    {/* Minutes Slider */}
                    {(()=>{
                      const basePMin = model.pMin||30;
                      const activePMin = minutesOverride!=null ? minutesOverride : basePMin;
                      const minSlider = Math.max(1, Math.round((basePMin-10)*2)/2);
                      const maxSlider = Math.round((basePMin+10)*2)/2;
                      const diffMin = +(activePMin - basePMin).toFixed(1);
                      return(
                        <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",marginBottom:"1rem"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.5rem"}}>
                            <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",letterSpacing:"0.08em"}}>PROJ MINUTES</span>
                            <div style={{display:"flex",alignItems:"baseline",gap:"0.4rem"}}>
                              <span style={{color:"#4a9eff",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.4rem",lineHeight:1}}>{activePMin.toFixed(1)}</span>
                              {diffMin!==0&&<span style={{color:diffMin>0?"#00e676":"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem"}}>{diffMin>0?"+":""}{diffMin}</span>}
                              <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>base {basePMin.toFixed(1)}</span>
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:"0.4rem"}}>
                              <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>MATCHUP</span>
                              <span style={{color:(model.matchupFactor||1)>=1?"#00e676":"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",fontWeight:600}}>{(((model.matchupFactor||1)-1)*100).toFixed(1)}%</span>
                            </div>
                          </div>
                          <input type="range" min={minSlider} max={maxSlider} step="0.5"
                            value={activePMin}
                            onChange={e=>{setMinutesOverride(parseFloat(e.target.value));setProjOverride("");}}
                            style={{width:"100%",accentColor:"#4a9eff",cursor:"pointer"}}
                          />
                          <div style={{display:"flex",justifyContent:"space-between",marginTop:"0.15rem"}}>
                            <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>{minSlider} min</span>
                            <span style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>{maxSlider} min</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* confidence */}
                    {simStats&&(
                      <>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.4rem"}}>
                          <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",letterSpacing:"0.1em"}}>OVER PROBABILITY</span>
                          <span style={{color:"#4a9eff",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",fontWeight:600}}>{simStats.overPct}%</span>
                        </div>
                        <Bar value={simStats.overPct} color={simStats.overPct>=60?"#00e676":simStats.overPct>=45?"#ffee58":"#ff7043"}/>
                      </>
                    )}
                  </div>

                  {/* BOOM / BUST / CEILING CARD */}
                  {sim&&simStats&&activePropLine&&(()=>{
                    const prop=parseFloat(activePropLine);
                    if(!prop||prop<=0) return null;
                    const ceilScore=computeCeilingScore({
                      boomPct:simStats.boomPct||0,
                      p90:sim.p90,
                      propLine:prop,
                      matchupVarFactor:model?.matchupVarFactor||1,
                      minuteStability:model?.minuteStability??0.5,
                      sdRate:model?.sdRate||0.1,
                      meanRate:model?.meanRate||1,
                    });
                    const ceilColor=ceilScore>=70?"#00e676":ceilScore>=45?"#ffee58":"#ff7043";
                    return(
                      <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
                        <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span>Boom · Bust · Ceiling</span>
                          {model?.minuteStability!=null&&(
                            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.62rem",color:model.minuteStability>=0.7?"#00e676":model.minuteStability>=0.4?"#ffee58":"#ff7043"}}>
                              MIN STABILITY {(model.minuteStability*100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        {/* Ceiling score gauge */}
                        <div style={{display:"flex",alignItems:"center",gap:"1rem",marginBottom:"0.85rem"}}>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.3rem"}}>
                              <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.08em"}}>CEILING SCORE</span>
                              <span style={{color:ceilColor,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.1rem",lineHeight:1}}>{ceilScore}/100</span>
                            </div>
                            <div style={{background:"#0a1628",borderRadius:4,height:10,overflow:"hidden"}}>
                              <div style={{width:`${ceilScore}%`,height:"100%",background:`linear-gradient(90deg,${ceilColor}80,${ceilColor})`,borderRadius:4,transition:"width 0.8s ease"}}/>
                            </div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.56rem",marginTop:"0.25rem"}}>
                              based on boom%, P90 vs line, matchup variance, minute stability
                            </div>
                          </div>
                        </div>
                        {/* Boom / Bust grid */}
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.75rem"}}>
                          <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem"}}>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.08em",marginBottom:"0.3rem"}}>💥 BOOM CHANCE</div>
                            <div style={{color:"#00e676",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.8rem",lineHeight:1}}>{simStats.boomPct??'—'}%</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.25rem"}}>
                              hitting ≥ {simStats.boomLine??'—'} ({prop>0?"+25%":""})
                            </div>
                            <div style={{marginTop:"0.4rem",background:"#0a1628",borderRadius:3,height:5,overflow:"hidden"}}>
                              <div style={{width:`${Math.min(100,(simStats.boomPct||0)*2.5)}%`,height:"100%",background:"#00e676",borderRadius:3}}/>
                            </div>
                          </div>
                          <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem"}}>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.08em",marginBottom:"0.3rem"}}>💣 BUST CHANCE</div>
                            <div style={{color:"#ff7043",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.8rem",lineHeight:1}}>{simStats.bustPct??'—'}%</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.25rem"}}>
                              below {simStats.bustLine??'—'} ({prop>0?"-20%":""})
                            </div>
                            <div style={{marginTop:"0.4rem",background:"#0a1628",borderRadius:3,height:5,overflow:"hidden"}}>
                              <div style={{width:`${Math.min(100,(simStats.bustPct||0)*2.5)}%`,height:"100%",background:"#ff7043",borderRadius:3}}/>
                            </div>
                          </div>
                        </div>
                        {/* Matchup context */}
                        {model?.oppRate&&(
                          <div style={{marginTop:"0.75rem",background:"#050d1a",borderRadius:6,padding:"0.5rem 0.75rem",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"0.5rem"}}>
                            <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>
                              OPP RATE <span style={{color:"#4a9eff"}}>{model.oppRate}/min</span>
                              {" vs LEAGUE "}
                              <span style={{color:"#8ba7c0"}}>{model.leagueAvgRate}/min</span>
                            </span>
                            <span style={{color:model.matchupVarFactor>1?"#00e676":"#ff7043",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",fontWeight:600}}>
                              VAR {model.matchupVarFactor>1?"+":""}{((model.matchupVarFactor-1)*100).toFixed(1)}% · MEAN {model.matchupFactor>1?"+":""}{((model.matchupFactor-1)*100).toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* MODEL STATS CARD (game log mode) */}
                  {inputMode==="gamelog"&&model&&(
                    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
                      <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <span style={{color:"#4a9eff"}}>Model Stats</span>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"0.65rem",color:model.useRecency?"#00e676":"#3a6080",letterSpacing:"0.1em"}}>
                          {model.useRecency?"⚡ RECENCY ON":"∅ RECENCY OFF"}
                          {model.useRecency&&` · λ=${model.decayStrength.toFixed(2)}`}
                          {model.useRecency&&model.sampleBlend<1&&` · blend=${(model.sampleBlend*100).toFixed(0)}%`}
                        </span>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.5rem"}}>
                        {[
                          [model.useRecency?"WEIGHTED MEAN RATE":"MEAN RATE",
                           model.useRecency?model.weightedMeanRate?.toFixed(4):model.plainMeanRate?.toFixed(4),
                           "#4a9eff"],
                          ["MEDIAN RATE", model.medianRate?.toFixed(4), "#ffee58"],
                          ["BLENDED RATE (70/30)", model.blendedRate?.toFixed(4), "#00e676"],
                          [model.useRecency?"WEIGHTED MEAN MIN":"MEAN MIN",
                           model.useRecency?model.weightedMeanMin:model.plainMeanMin,
                           "#8ba7c0"],
                          ["PROJ MIN", model.pMin?.toFixed(1), "#4a9eff"],
                          ["GAMES USED", model.n, "#3a8060"],
                        ].map(([lbl,val,col])=>(
                          <div key={lbl} style={{background:"#050d1a",borderRadius:6,padding:"0.5rem 0.65rem"}}>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.06em",marginBottom:"0.2rem"}}>{lbl}</div>
                            <div style={{color:col,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.9rem",fontWeight:600}}>{val??'—'}</div>
                          </div>
                        ))}
                      </div>
                      {/* SD Breakdown */}
                      {model.useRecency&&model.weightedSdRate!=null&&(
                        <div style={{marginTop:"0.5rem",background:"#050d1a",borderRadius:6,padding:"0.5rem 0.65rem"}}>
                          <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem",letterSpacing:"0.06em",marginBottom:"0.3rem"}}>SD BREAKDOWN (RATE)</div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.3rem"}}>
                            {[["WEIGHTED",model.weightedSdRate?.toFixed(4),"#4a9eff"],["UNWEIGHTED",model.unweightedSdRate?.toFixed(4),"#3a6080"],["FINAL (50/50)",model.sdRate?.toFixed(4),"#00e676"]].map(([l,v,c])=>(
                              <div key={l}>
                                <div style={{color:"#1e3050",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.52rem"}}>{l}</div>
                                <div style={{color:c,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",fontWeight:600}}>{v}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem",letterSpacing:"0.06em",marginTop:"0.4rem",marginBottom:"0.3rem"}}>SD BREAKDOWN (MIN)</div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.3rem"}}>
                            {[["WEIGHTED",model.weightedSdMin?.toFixed(2),"#4a9eff"],["UNWEIGHTED",model.unweightedSdMin?.toFixed(2),"#3a6080"],["FINAL (50/50)",model.sdMin?.toFixed(2),"#00e676"]].map(([l,v,c])=>(
                              <div key={l}>
                                <div style={{color:"#1e3050",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.52rem"}}>{l}</div>
                                <div style={{color:c,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem",fontWeight:600}}>{v}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {model.useRecency&&model.plainMeanRate&&model.weightedMeanRate&&(
                        <div style={{marginTop:"0.6rem",background:"#050d1a",borderRadius:6,padding:"0.5rem 0.65rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",letterSpacing:"0.06em"}}>RECENCY SHIFT vs PLAIN MEAN</span>
                          <span style={{color:model.weightedMeanRate>=model.plainMeanRate?"#00e676":"#ff7043",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1rem"}}>
                            {model.weightedMeanRate>=model.plainMeanRate?"+":""}{((model.weightedMeanRate-model.plainMeanRate)/model.plainMeanRate*100).toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* HIT RATE CHART */}
                  {inputMode==="gamelog"&&pasteParsedLogs.length>0&&activePropLine&&(
                    <HitRateChart
                      logs={pasteParsedLogs}
                      h2hLogs={pasteParsedH2H}
                      propLine={activePropLine}
                      statType={logForm.statType||"Points"}
                      dvpData={dvp.dvpData}
                      dvpOpp={dvpOpp}
                      l5Opp={logForm.l5OppAllowed}
                      l10Opp={logForm.l10OppAllowed}
                      l20Opp={logForm.l20OppAllowed}
                    />
                  )}

                  {/* DISTRIBUTION CHART */}
                  {sim&&(
                    <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
                      <div style={{fontFamily:"'Black Han Sans',sans-serif",color:"#4a9eff",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a"}}>Distribution</div>
                      <SimDistChart
                        outcomes={sim.outcomes}
                        propLine={activePropLine}
                        projection={effectiveProj}
                        p10={sim.p10} p25={sim.p25} p50={sim.simMedian} p75={sim.p75} p90={sim.p90}
                      />
                    </div>
                  )}

                  {/* MONTE CARLO CARD */}
                  {sim&&simStats&&<MonteCarloCard sim={sim} simStats={simStats} propLine={activePropLine}/>}

                  {/* BOOM / BUST / CEILING CARD */}
                  {sim&&activePropLine&&(()=>{
                    const propN=parseFloat(activePropLine);
                    const bb=computeBoomBust(sim.outcomes,propN);
                    const cs=computeCeilingScore({
                      boomPct:bb?.boomPct||0, p90:sim.p90, propLine:propN,
                      matchupVarFactor:model.matchupVarFactor||1,
                      sdRate:model.sdRate||0.1, meanRate:model.meanRate||1,
                      minuteStability:model.minuteStability??0.7,
                    });
                    const csColor=cs>=70?"#00e676":cs>=45?"#ffee58":"#ff7043";
                    if(!bb) return null;
                    return(
                      <div style={{background:"#080f1e",border:"1px solid #0e2040",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
                        <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.72rem",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:"0.75rem",paddingBottom:"0.4rem",borderBottom:"1px solid #1e3a5a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span style={{color:"#a78bfa"}}>Boom · Bust · Ceiling</span>
                          <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>
                            {model.statType||""} · {model.minuteStability!=null?`min stability ${(model.minuteStability*100).toFixed(0)}%`:""}
                          </span>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.75rem",marginBottom:"0.75rem"}}>
                          {/* Boom */}
                          <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",textAlign:"center",border:"1px solid #00e67620"}}>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.1em",marginBottom:"0.25rem"}}>BOOM CHANCE</div>
                            <div style={{color:"#00e676",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.8rem",lineHeight:1}}>{bb.boomPct}%</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.25rem"}}>≥ {bb.boomLine}</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>(125% of line)</div>
                          </div>
                          {/* Bust */}
                          <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",textAlign:"center",border:"1px solid #ff704320"}}>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.1em",marginBottom:"0.25rem"}}>BUST CHANCE</div>
                            <div style={{color:"#ff7043",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.8rem",lineHeight:1}}>{bb.bustPct}%</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.25rem"}}>≤ {bb.bustLine}</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>(80% of line)</div>
                          </div>
                          {/* Ceiling Score */}
                          <div style={{background:"#0a1628",borderRadius:8,padding:"0.75rem",textAlign:"center",border:`1px solid ${csColor}20`}}>
                            <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.1em",marginBottom:"0.25rem"}}>CEILING SCORE</div>
                            <div style={{color:csColor,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.8rem",lineHeight:1}}>{cs}</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.25rem"}}>/ 100</div>
                            <div style={{color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.55rem"}}>{cs>=70?"high upside":cs>=45?"moderate":"limited"}</div>
                          </div>
                        </div>
                        {/* Matchup context row */}
                        {model.matchupRatio&&model.matchupRatio!==1&&(
                          <div style={{background:"#050d1a",borderRadius:6,padding:"0.5rem 0.75rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>
                              OPP ALLOWED RATE vs LEAGUE AVG
                            </span>
                            <div style={{display:"flex",gap:"1rem",alignItems:"center"}}>
                              <span style={{color:"#a78bfa",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.72rem"}}>
                                {model.matchupOppRate?.toFixed(3)}/min
                              </span>
                              <span style={{
                                color:model.matchupRatio>=1.03?"#00e676":model.matchupRatio<=0.97?"#ff7043":"#ffee58",
                                fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.8rem"
                              }}>
                                {model.matchupRatio>=1.03?"↑ EASY":model.matchupRatio<=0.97?"↓ TOUGH":"≈ NEUTRAL"}
                                {" "}{((model.matchupRatio-1)*100>0?"+":"")+((model.matchupRatio-1)*100).toFixed(1)}%
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* ALT LINE CHECKER */}
                  {sim&&<AltChecker simOutcomes={sim.outcomes}/>}

                  {/* H2H CARD (summary mode) */}
                  {inputMode==="summary"&&model.h2hBlend!=null&&(
                    <div style={{background:"#080f1e",border:"1px solid #2a3a0a",borderRadius:12,padding:"1.25rem",marginBottom:"1rem"}}>
                      <div style={{...SEC("#ff9800")}}>Head-to-Head Influence</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.75rem",marginBottom:"0.75rem"}}>
                        <div style={{background:"#050d1a",borderRadius:6,padding:"0.65rem",textAlign:"center"}}>
                          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>H2H AVG</div>
                          <div style={{color:"#ff9800",fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.4rem",lineHeight:1.1}}>{form.h2hAvg||"—"}</div>
                          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem",marginTop:"0.2rem"}}>{form.h2hGames?`${form.h2hGames} game${form.h2hGames!=="1"?"s":""}`:""}</div>
                        </div>
                        <div style={{background:"#050d1a",borderRadius:6,padding:"0.65rem",textAlign:"center"}}>
                          <div style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.6rem"}}>H2H WEIGHT</div>
                          <div style={{color:h2hLabel(parseInt(form.h2hGames)||0).color,fontFamily:"'Black Han Sans',sans-serif",fontSize:"1.4rem",lineHeight:1.1}}>{Math.round(model.h2hBlendW*35)}%</div>
                          <div style={{color:h2hLabel(parseInt(form.h2hGames)||0).color,fontFamily:"'JetBrains Mono',monospace",fontSize:"0.58rem",marginTop:"0.2rem"}}>{h2hLabel(parseInt(form.h2hGames)||0).text}</div>
                        </div>
                      </div>
                      {form.h2hGames&&<H2HBar games={parseInt(form.h2hGames)||0}/>}
                    </div>
                  )}

                  {/* BUTTONS */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.75rem"}}>
                    <button onClick={()=>{setDone(false);setSim(null);setModel(null);window.scrollTo({top:0,behavior:'smooth'});}} style={{padding:"0.8rem",background:"transparent",color:"#4a9eff",border:"1px solid #1e3a5a",borderRadius:8,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.95rem",letterSpacing:"0.1em",cursor:"pointer"}}>✏️ EDIT</button>
                    <button onClick={()=>{setForm(EMPTY_FORM);setLogForm(EMPTY_LOG);setModel(null);setSim(null);setDone(false);setProjOverride("");setActivePropLine("");setMinutesOverride(null);setPasteParsedLogs([]);setPasteParsedH2H([]);setGameLimit(0);setMinFilter(0);nba.setPlayerId(null);nba.setPlayerName("");nba.setLoaded(false);nba.setError("");setDvpOpp("");window.scrollTo({top:0,behavior:'smooth'});}} style={{padding:"0.8rem",background:"transparent",color:"#3a6080",border:"1px solid #1e3a5a",borderRadius:8,fontFamily:"'Black Han Sans',sans-serif",fontSize:"0.95rem",letterSpacing:"0.1em",cursor:"pointer"}}>+ NEW PROP</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ══ EDGE FINDER ══ */}
          {mainTab==="edge"&&(
            <EdgeFinder apiBase={API_BASE} onAnalyze={async (player, statType, line, position, game) => {
              // Derive opponent from gameID
              let opp = "";
              if (game?.gameID) {
                try { opp = game.gameID.split("_")[1].split("@")[1]; } catch {}
              }

              // 1. Switch to lab + game log mode + scroll, clear stale results
              setMainTab("lab");
              setInputMode("gamelog");
              setDone(false);
              setSim(null);
              setModel(null);
              setPasteParsedLogs([]);
              setPasteParsedH2H([]);
              pendingAnalyzeRef.current = false;
              window.scrollTo({top:0,behavior:"smooth"});

              // 2. Set form fields
              setLogForm(f=>({...f, statType, propLine:String(line), playerName:player}));

              // 3. Set DvP position + opponent
              dvp.setPosition(position||"PG");
              setDvpOpp(opp);

              // 4. Find player ID
              let matchId = null, matchName = player;
              try {
                const sr = await fetch(`${API_BASE}/players/search?q=${encodeURIComponent(player.split(" ").slice(-1)[0])}`);
                const list = sr.ok ? await sr.json() : [];
                const m = list.find(p=>p.full_name.toLowerCase()===player.toLowerCase())
                       || list.find(p=>p.full_name.toLowerCase().includes(player.toLowerCase()));
                if (m) { matchId = m.id; matchName = m.full_name; }
              } catch {}

              // 5. Set NBA player state (fills the search box + enables Load)
              if (matchId) {
                nba.setPlayerId(matchId);
                nba.setPlayerName(matchName);
                nba.setOpponent(opp);
                nba.setLoaded(false);
                nba.setError("");

                // 6. Load game logs
                const data = await nba.loadData(matchId, matchName, statType);

                if (data) {
                  // 7. Apply game limit + min filter (reuse handleNBALoad logic)
                  const limit = parseInt(gameLimit) || 0;
                  const minMin = parseFloat(minFilter) || 0;
                  const allLogs = data.recent_logs || [];
                  const filtered = minMin > 0 ? allLogs.filter(r=>parseFloat(r.min)>=minMin) : allLogs;
                  const sliced  = limit > 0 ? filtered.slice(0, limit) : filtered;
                  setPasteParsedLogs(sliced);
                  if (opp && data.h2h_logs) setPasteParsedH2H(data.h2h_logs);
                  setLogSubTab("paste");

                  // 8. Fill L5/L10/L20
                  const calcW = (logs, n) => {
                    const w = logs.slice(0,n);
                    if (!w.length) return null;
                    const stats = w.map(r=>parseFloat(r.stat)||0);
                    const mins  = w.map(r=>parseFloat(r.min)||0);
                    return {
                      avg: +(stats.reduce((a,b)=>a+b,0)/stats.length).toFixed(1),
                      mpg: +(mins.reduce((a,b)=>a+b,0)/mins.length).toFixed(1),
                      median: +([...stats].sort((a,b)=>a-b)[Math.floor(stats.length/2)]).toFixed(1),
                    };
                  };
                  const l5=calcW(sliced,5)||data.l5, l10=calcW(sliced,10)||data.l10, l20=calcW(sliced,20)||data.l20;
                  const upd = {playerName: matchName};
                  if(l5)  { upd.l5Avg=String(l5.avg);   upd.l5Mpg=String(l5.mpg);   upd.l5Med=String(l5.median); }
                  if(l10) { upd.l10Avg=String(l10.avg);  upd.l10Mpg=String(l10.mpg);  upd.l10Med=String(l10.median); }
                  if(l20) { upd.l20Avg=String(l20.avg);  upd.l20Mpg=String(l20.mpg);  upd.l20Med=String(l20.median); }
                  setLogForm(f=>({...f, ...upd}));

                  // 9. Flag for auto-analyze — fires via useEffect once logs are in state
                  pendingAnalyzeRef.current = true;
                }
              }
            }}/>
          )}

          {/* ══ HISTORY ══ */}
          {mainTab==="history"&&(
            <div>
              {history.length===0?(
                <div style={{textAlign:"center",padding:"4rem 1rem",color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.85rem"}}>
                  <div style={{fontSize:"2.5rem",marginBottom:"1rem"}}>📋</div>
                  No props analyzed yet.<br/>Head to the Lab to get started.
                </div>
              ):(
                <>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem"}}>
                    <span style={{color:"#3a6080",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.75rem"}}>{history.length} prop{history.length!==1?"s":""} saved</span>
                    <button onClick={()=>persist([])} style={{background:"none",border:"1px solid #2a4060",borderRadius:6,color:"#2a4060",fontFamily:"'JetBrains Mono',monospace",fontSize:"0.7rem",padding:"0.3rem 0.7rem",cursor:"pointer"}}>Clear All</button>
                  </div>
                  {history.map(e=><HistCard key={e.id} e={e} onDel={id=>persist(history.filter(x=>x.id!==id))} onLoad={loadEntry}/>)}
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </>
  );
}
