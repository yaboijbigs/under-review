"use client";
import { useEffect } from "react";
export function RevealEvent() {
  useEffect(()=>{
    const reveal=()=>{
      let id:string;try{id=decodeURIComponent(window.location.hash.slice(1));}catch{return;}
      if(!id.startsWith("event-")&&!id.startsWith("play-"))return;
      const target=document.getElementById(id);if(!(target instanceof HTMLDetailsElement))return;
      target.open=true;
      let ancestor=target.parentElement?.closest("details");
      while(ancestor){ancestor.open=true;ancestor=ancestor.parentElement?.closest("details")??null;}
      requestAnimationFrame(()=>target.scrollIntoView({block:"start"}));
    };
    reveal();window.addEventListener("hashchange",reveal);
    return ()=>window.removeEventListener("hashchange",reveal);
  },[]);
  return null;
}
