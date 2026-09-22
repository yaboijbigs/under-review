import { ImageResponse } from "next/og";
import { getReport } from "@under-review/core/repository";
import { getGameVerdict } from "@under-review/core/consumer-summary";
import { config } from "@under-review/core/config";
export const alt = "Under Review NFL game suspicion rating, final score, and supporting evidence.";
export const size = {width:1200,height:630};
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export default async function ReportImage({params}: {params: Promise<{gameId:string}>}) {
  const {gameId}=await params; let report=null; try {report=await getReport(gameId);} catch {}
  const verdict=getGameVerdict(report?.revision.analysis.gameAudit,!!report);
  const color=verdict.tone==='high'?'#ffc29a':verdict.tone==='elevated'?'#ffe48a':'#e2ff54';
  return new ImageResponse(<div style={{display:"flex",flexDirection:"column",width:"100%",height:"100%",padding:"45px 65px",background:"#20231f",color:"#f4f3ed",fontFamily:"sans-serif",borderTop:`14px solid ${color}`}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:29,fontWeight:800,letterSpacing:-1}}>{config.brandName.toUpperCase()}</span><span style={{fontSize:15,color:"#acb89d"}}>AUTOMATIC NFL GAME REPORTS</span></div>
    <div style={{display:"flex",alignItems:"center",gap:35,marginTop:26}}>{report ? <><span style={{fontSize:60,fontWeight:800}}>{report.game.awayTeam} {report.game.awayScore ?? "—"}</span><span style={{fontSize:22,color:"#8d9a7e"}}>AT</span><span style={{fontSize:60,fontWeight:800}}>{report.game.homeTeam} {report.game.homeScore ?? "—"}</span></> : <span style={{fontSize:46,fontWeight:800}}>The next report is on its way.</span>}</div>
    <div style={{display:"flex",fontSize:15,color:"#acb89d",marginTop:24}}>GAME SUSPICION RATING · AUTOMATIC SCREENING</div><div style={{display:"flex",fontSize:51,lineHeight:1.12,fontWeight:800,color,marginTop:8}}>{verdict.label}{verdict.rating ? ` · ${verdict.rating}/5` : ""}</div><div style={{display:"flex",fontSize:18,color,marginTop:8}}>Not a finding of manipulation</div>
    <div style={{display:"flex",fontSize:20,lineHeight:1.4,marginTop:16,color:"#d2d9c9",maxHeight:100,overflow:"hidden"}}>{verdict.rating && verdict.rating <= 2 ? verdict.definition : verdict.reasons.length ? verdict.reasons.slice(0,2).join(' ') : verdict.summary}</div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"auto",paddingTop:20,borderTop:"1px solid #48523e"}}><span style={{fontSize:17,color}}>{report ? 'AUTOMATED ANALYSIS COMPLETE' : 'WAITING FOR FINAL GAME DATA'}</span><span style={{fontSize:15,color:"#acb89d"}}>{verdict.reviewCount ? `${verdict.reviewCount} key plays to inspect` : 'See the evidence. Understand the result.'}</span></div>
  </div>,size);
}
