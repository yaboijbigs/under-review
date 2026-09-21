"use client";
export default function ErrorPage({reset}: {error: Error & {digest?: string}; reset: () => void}) { return <div className="empty-state"><p className="eyebrow">TEMPORARILY UNAVAILABLE</p><h1>The record couldn't be loaded.</h1><p>No results have been substituted. Please try again.</p><button className="button dark" onClick={() => reset()}>Try again</button></div>; }
