"""Monotonic timestamp comparison with split/joined words matched as groups."""
import re

def normalize(word):
    return ''.join(re.findall(r'\w+',word.casefold()))

def percentile(values,p):
    if not values:return None
    values=sorted(values)
    i=(len(values)-1)*p
    lo=int(i)
    hi=min(len(values)-1,lo+1)
    return round(values[lo]+(values[hi]-values[lo])*(i-lo),1)

def compare(reference,candidate):
    ref=[w for w in reference if normalize(w.get('word',''))]
    cand=[w for w in candidate if normalize(w.get('word',''))]
    n,m=len(ref),len(cand)
    rn=[normalize(w['word']) for w in ref]
    cn=[normalize(w['word']) for w in cand]
    costs=[[0.0]*(m+1) for _ in range(n+1)]
    steps={}
    for i in range(n,-1,-1):
        for j in range(m,-1,-1):
            if i==n and j==m:continue
            choices=[]
            for r in range(1,min(3,n-i)+1):
                for c in range(1,min(3,m-j)+1):
                    if ''.join(rn[i:i+r])==''.join(cn[j:j+c]):
                        choices.append((costs[i+r][j+c]+.001*(r+c-2),r,c,True))
            if i<n and j<m:choices.append((costs[i+1][j+1]+2,1,1,False))
            if i<n:choices.append((costs[i+1][j]+1,1,0,False))
            if j<m:choices.append((costs[i][j+1]+1,0,1,False))
            best=min(choices,key=lambda x:x[0])
            costs[i][j]=best[0]
            steps[i,j]=best[1:]
    pairs=[]
    i=j=matched_ref=matched_cand=0
    while i<n or j<m:
        r,c,matched=steps[i,j]
        if matched:
            x,y=ref[i:i+r],cand[j:j+c]
            matched_ref+=r
            matched_cand+=c
            if all(w.get(k) is not None for w in x+y for k in ['start','end']):
                ds=round((y[0]['start']-x[0]['start'])*1000,1)
                de=round((y[-1]['end']-x[-1]['end'])*1000,1)
                pairs.append({'word':' '.join(w['word'] for w in x),'candidate_word':' '.join(w['word'] for w in y),'reference_start':float(x[0]['start']),'reference_end':float(x[-1]['end']),'candidate_start':float(y[0]['start']),'candidate_end':float(y[-1]['end']),'start_delta_ms':float(ds),'end_delta_ms':float(de),'reference_word_count':r,'candidate_word_count':c})
        i+=r
        j+=c
    starts=[abs(w['start_delta_ms']) for w in pairs]
    ends=[abs(w['end_delta_ms']) for w in pairs]
    stats=lambda values:{'median':percentile(values,.5),'p90':percentile(values,.9),'p95':percentile(values,.95),'max':max(values,default=None)}
    return {'reference_words':n,'candidate_words':m,'matched_word_groups':len(pairs),'matched_reference_words':matched_ref,'matched_candidate_words':matched_cand,'unmatched_reference_words':n-matched_ref,'unmatched_candidate_words':m-matched_cand,'start_absolute_ms':stats(starts),'end_absolute_ms':stats(ends),'groups_over_100ms_either_boundary':sum(max(abs(w['start_delta_ms']),abs(w['end_delta_ms']))>100 for w in pairs),'groups_over_200ms_either_boundary':sum(max(abs(w['start_delta_ms']),abs(w['end_delta_ms']))>200 for w in pairs),'largest_disagreements':sorted(pairs,key=lambda w:max(abs(w['start_delta_ms']),abs(w['end_delta_ms'])),reverse=True)[:20],'pairs':pairs}
