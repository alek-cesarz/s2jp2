// COD marker types. The parser + capability validator land in Task 6;
// only the ProgressionOrder type alias is needed here so src/profile.ts
// can keep its forward type import resolvable today.

export type ProgressionOrder = 'LRCP' | 'RLCP' | 'RPCL' | 'PCRL' | 'CPRL';
