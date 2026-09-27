import { z } from 'zod';

export const refereeAssignmentSourceSchema=z.object({
 provider:z.enum(['football-zebras','sharp-football']),
 name:z.string().trim().min(1).max(100),
 url:z.string().url(),snapshotId:z.string().min(1).max(200),checksum:z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((source,ctx)=>{
 let url:URL;try{url=new URL(source.url);}catch{ctx.addIssue({code:'custom',message:'Invalid referee assignment source URL.'});return;}
 const allowed=url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&(
  source.provider==='football-zebras'
   ?url.hostname==='www.footballzebras.com'&&/^\/\d{4}\/\d{2}\/week-\d{1,2}-referee-assignments-\d{4}\/?$/.test(url.pathname)
   :url.hostname==='www.sharpfootballanalysis.com'&&url.pathname==='/betting/nfl-referee-assignments-penalty-trends-betting-impact/');
 if(!allowed)ctx.addIssue({code:'custom',message:'Unexpected referee assignment source URL.'});
});

/** Public publisher assignments are separate from immutable nflverse game records. */
export const refereeAssignmentSchema=z.object({
 gameId:z.string(),season:z.number().int().min(1999).max(2100),week:z.number().int().min(1).max(22),
 name:z.string().trim().min(1).max(100).nullable(),status:z.enum(['reported','conflict']),
 sources:z.array(refereeAssignmentSourceSchema).min(1).max(2),
}).superRefine((assignment,ctx)=>{
 const game=/^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(assignment.gameId);
 if(!game||Number(game[1])!==assignment.season||Number(game[2])!==assignment.week||game[3]===game[4])ctx.addIssue({code:'custom',message:'Assignment game identity does not match its season and week.'});
 if((assignment.status==='reported')!==(assignment.name!==null))ctx.addIssue({code:'custom',message:'Only an undisputed assignment may name a referee.'});
 if(new Set(assignment.sources.map(source=>source.provider)).size!==assignment.sources.length)ctx.addIssue({code:'custom',message:'Duplicate referee assignment provider.'});
 for(const source of assignment.sources){
  if(source.provider!=='football-zebras')continue;
  let url:URL;try{url=new URL(source.url);}catch{continue;}
  const match=/\/week-(\d{1,2})-referee-assignments-(\d{4})\/?$/.exec(url.pathname);
  if(!match||Number(match[1])!==assignment.week||Number(match[2])!==assignment.season)ctx.addIssue({code:'custom',message:'Publisher article does not match assignment season and week.'});
 }
});
export type RefereeAssignment=z.infer<typeof refereeAssignmentSchema>;
export type RefereeAssignmentSource=z.infer<typeof refereeAssignmentSourceSchema>;
