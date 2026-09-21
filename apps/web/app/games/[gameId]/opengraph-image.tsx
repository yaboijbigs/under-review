import { ImageResponse } from "next/og";
import { getReport } from "@under-review/core/repository";
import { config } from "@under-review/core/config";
export const alt = "Independent NFL game report. Evidence-backed findings and coverage from Under Review.";
export const size = {width:1200,height:630};
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export default async function ReportImage({params}: {params: Promise<{gameId:string}>}) {
  const {gameId}=await params; let report=null; try {report=await getReport(gameId);} catch {}
  return new ImageResponse(<div style={{display:"flex",flexDirection:"column",width:"100%",height:"100%",padding:"55px 65px",background:"#20231f",color:"#f4f3ed",fontFamily:"sans-serif",borderTop:"14px solid #e2ff54"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:29,fontWeight:800,letterSpacing:-1}}>{config.brandName.toUpperCase()}</span><span style={{fontSize:15,color:"#acb89d"}}>THE POSTGAME RECORD</span></div><div style={{display:"flex",alignItems:"center",gap:45,marginTop:65}}>{report ? <><span style={{fontSize:70,fontWeight:800}}>{report.game.awayTeam} {report.game.awayScore ?? "—"}</span><span style={{fontSize:24,color:"#8d9a7e"}}>AT</span><span style={{fontSize:70,fontWeight:800}}>{report.game.homeTeam} {report.game.homeScore ?? "—"}</span></> : <span style={{fontSize:60,fontWeight:800}}>The record is open.</span>}</div><div style={{display:"flex",fontSize:25,lineHeight:1.4,marginTop:30,color:"#d2d9c9",maxHeight:115,overflow:"hidden"}}>{report ? report.revision.summary.slice(0,220) : "Independent analysis. Inspectable evidence. Explicit uncertainty."}</div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"auto",paddingTop:20,borderTop:"1px solid #48523e"}}><span style={{fontSize:17,color:"#e2ff54"}}>{report ? `${report.revision.statisticalStatus.toUpperCase()} · REVISION ${report.revision.number}` : "AWAITING VALIDATED DATA"}</span><span style={{fontSize:15,color:"#acb89d"}}>Rarity is not evidence of manipulation.</span></div></div>,size);
}
