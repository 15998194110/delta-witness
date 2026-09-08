# TOLL402 automation evidence — 2026-09-09

## TOLL402 official submit surface
checked_utc: 2026-09-08T20:01:16Z

form_controls:
```json
[
  [
    "form",
    {}
  ],
  [
    "input",
    {
      "placeholder": "TrophyCoach MCP",
      "value": ""
    }
  ],
  [
    "input",
    {
      "placeholder": "TrophyCoach",
      "value": ""
    }
  ],
  [
    "input",
    {
      "type": "email",
      "placeholder": "you@example.com",
      "value": ""
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "input",
    {
      "placeholder": "Live Clash Royale metagame data for AI agents\u2026",
      "value": ""
    }
  ],
  [
    "input",
    {
      "placeholder": "https://mcp.trophycoach.com/api/mcp",
      "value": ""
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "button",
    {
      "type": "button"
    }
  ],
  [
    "input",
    {
      "placeholder": "min 0.005",
      "value": ""
    }
  ],
  [
    "input",
    {
      "placeholder": "max 0.01",
      "value": ""
    }
  ],
  [
    "input",
    {
      "placeholder": "note \u2014 e.g. free overview tool",
      "value": ""
    }
  ],
  [
    "textarea",
    {
      "placeholder": "get_deck_meta \u00b7 0.005 \u00b7 Dominant decks, threats, card levels for a trophy range."
    }
  ],
  [
    "input",
    {
      "placeholder": "gaming, data",
      "value": ""
    }
  ],
  [
    "input",
    {
      "placeholder": "https://docs.trophycoach.com",
      "value": ""
    }
  ],
  [
    "button",
    {
      "type": "submit"
    }
  ]
]
```

script_findings:
```json
[
  {
    "script": "https://toll402.com/_next/static/chunks/app/submit/page-e03808ebf3e0c4a7.js?dpl=dpl_9ZFd6cgodCsfZH2JrkpVxHDNoJMs",
    "api_hits": [
      "/api/contact"
    ],
    "contexts": [
      "\" font-mono text-[12.5px]\")})]})]}),(0,s.jsxs)(\"div\",{className:\"flex items-center gap-[18px] border-t border-t-line mt-[4px] pt-[20px] flex-wrap\",children:[(0,s.jsx)(\"button\",{type:\"submit\",disabled:\"sending\"===R||\"sent\"===R,className:\"font-mono text-[12px] tracking-[0.04em] font-semibold px-[22px] py-[11px] cursor-pointer disabled:cursor-default disabled:opacity-60 border-none bg-green text-bg hover:bg-green-bright transition-colors\",children:\"sending\"===R?\"SENDING\u2026\":\"sent\"===R?\"\u2713 SUBMITTED\":\"SUBMIT FOR REVIEW \u2192\"}),(0,s.jsx)(\"span\",{className:\"text-[12px] text-dim max-w-[320px]\",children:\"Sends directly to TOLL\\xb7402 \u2014 no account needed. We verify with a real paid call before listing.\"}),(0,s.jsx)(\"span\",{\"aria-live\":\"polite\",className:\"w-full text-[12px] \".concat(\"error\"===R?\"text-amber\":\"text-green\"),children:\"sent\"===R?\"Submission received. We\u2019ll use your contact email only for review follow-up.\":\"error\"===R?\"Couldn\u2019t send right now. Try the contact page instead.\":\"\"})]})]})}},6557:(e,a,t)=>{Promise.resolve().then(t.bind(t,7053)),Promise.resolve().then(t.bind(t,5847)),Promise.resolve().then(t.bind(t,8654)),Promise.resolve().then(t.t.bind(t,2619,23))}},e=>{e.O(0,[2740,314,8441,1255,7358],()=>e(e.s=6557)),_N_E=e.O()}]);"
    ]
  }
]
```

## Treasury fallback reads
canonical_usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
treasury: 0x1990e21bc219696ff7fbc26527dbaed335ac6367

blockscout_http: 200
blockscout_canonical_incoming_count_visible: 1
blockscout_canonical_incoming_visible:
```json
[
  {
    "timestamp": "2026-09-07T05:42:03.000000Z",
    "tx_hash": "0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3",
    "from": "0x7E6b6556322c4e26c567a867964aC793f5eE2b1c",
    "to": "0x1990e21bc219696ff7fbc26527dbaed335ac6367",
    "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "raw_value": {
      "decimals": "6",
      "value": "30000"
    }
  }
]
```
