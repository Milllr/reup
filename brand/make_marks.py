import math, subprocess, sys, os
out = sys.argv[1]
INK="#16331C"; LIGHT="#F4FAEE"
def pt(cx,cy,r,deg):
    a=math.radians(deg); return (cx+r*math.cos(a), cy+r*math.sin(a))
def sector(cx,cy,ro,ri,a0,a1):
    p0=pt(cx,cy,ro,a0); p1=pt(cx,cy,ro,a1); p2=pt(cx,cy,ri,a1); p3=pt(cx,cy,ri,a0)
    large=1 if (a1-a0)>180 else 0
    return f"M{p0[0]:.2f} {p0[1]:.2f}A{ro} {ro} 0 {large} 1 {p1[0]:.2f} {p1[1]:.2f}L{p2[0]:.2f} {p2[1]:.2f}A{ri} {ri} 0 {large} 0 {p3[0]:.2f} {p3[1]:.2f}Z"
UP='M10 14V26A11 11 0 0 0 32 26V14M32 26V56M32 14H43A11 11 0 0 1 43 36H32'
def up(c, lean=False):
    t = 'translate(6 -3) skewX(-8)' if lean else 'translate(1 -3)'
    return f'<g transform="{t}"><path d="{UP}" fill="none" stroke="{c}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></g>'
def block_r(c):
    return f'<path d="M10 16H29L23 54H10ZM37 8H56V27H34Z" fill="{c}" stroke="{c}" stroke-width="4" stroke-linejoin="round"/>'
def slots(c):
    s=[]
    for r in range(3):
        for k in range(3):
            x=14+k*18; y=14+r*18
            if k==0 or r==0: s.append(f'<circle cx="{x}" cy="{y}" r="7" fill="{c}"/>')
            else: s.append(f'<circle cx="{x}" cy="{y}" r="5.4" fill="none" stroke="{c}" stroke-width="2.2" opacity="0.4"/>')
    return ''.join(s)
def piece(c):
    cx,cy=31,35
    body=sector(cx,cy,21,10,-12,282)
    dx,dy=pt(0,0,7,-45)
    p=sector(cx+dx,cy+dy,21,10,-70,-20)
    return f'<path d="{body}{p}" fill="{c}" stroke="{c}" stroke-width="3.5" stroke-linejoin="round"/>'
def hooks(c):
    return f'<path d="M14 50V28A12 12 0 0 1 26 16H34M50 14V36A12 12 0 0 1 38 48H30" fill="none" stroke="{c}" stroke-width="11" stroke-linecap="round"/>'
def tally(c):
    # three bars cut by a rising fifth stroke; pieces computed so no mask is needed
    x1,y1,x2,y2=6,48,58,20
    m=(y2-y1)/(x2-x1); gap=7.5/math.cos(math.atan(abs(m)))
    yc=lambda x: y1+m*(x-x1)
    d=[]
    for x0 in (11,25,39):
        xa,xb=x0,x0+9; r=4.5
        d.append(f"M{xa} {12+r}A{r} {r} 0 0 1 {xb} {12+r}L{xb} {yc(xb)-gap:.2f}L{xa} {yc(xa)-gap:.2f}Z")
        la,lb=yc(xa)+gap, yc(xb)+gap
        if 54-r > lb:
            d.append(f"M{xa} {la:.2f}L{xb} {lb:.2f}V{54-r}A{r} {r} 0 0 1 {xa} {54-r}Z" if 54-r>la else f"M{xa} {min(la,54):.2f}L{xb} {lb:.2f}V{54-r}A{r} {r} 0 0 1 {xa} {min(la,54):.2f}Z")
    return f'<path d="{"".join(d)}" fill="{c}"/><path d="M{x1} {y1}L{x2} {y2}" stroke="{c}" stroke-width="8" stroke-linecap="round" fill="none"/>'
def wordmark(c, sw=8.5):
    r=12; top=20; base=44; mid=32; x=8; s=[]
    s.append(f"M{x} {top}V{base}M{x} {mid+1}A{r} {r} 0 0 1 {x+r} {top+0.5}H{x+r+2.5}")
    x+=r+2.5+11
    ex=x+r; e0=pt(ex,mid,r,36)
    s.append(f"M{ex-r} {mid}H{ex+r}A{r} {r} 0 1 0 {e0[0]:.2f} {e0[1]:.2f}")
    x+=2*r+11
    s.append(f"M{x} {top}V{mid}A{r} {r} 0 0 0 {x+2*r} {mid}V{top}")
    sx=x+2*r
    s.append(f"M{sx} {mid}V{base+16}M{sx} {top}H{sx+r}A{r} {r} 0 0 1 {sx+r} {base}H{sx}")
    w=sx+2*r+8
    return w, f'<path d="{"".join(s)}" fill="none" stroke="{c}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
marks={"up":up,"block-r":block_r,"slots":slots,"piece":piece,"hooks":hooks,"tally":tally,"up-lean":lambda c: up(c,True)}
os.makedirs(out,exist_ok=True)
for n,f in marks.items():
    for tone,col in (("ink",INK),("light",LIGHT)):
        open(f"{out}/reup-{n}-{tone}.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="reup mark: {n}">{f(col)}</svg>\n')
    open(f"{out}/reup-{n}.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="reup">{f("currentColor")}</svg>\n')
for tone,col in (("ink",INK),("light",LIGHT),("current","currentColor")):
    w,m=wordmark(col)
    name = "reup-wordmark.svg" if tone=="current" else f"reup-wordmark-{tone}.svg"
    open(f"{out}/{name}","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 8 {w} 60" role="img" aria-label="reup">{m}</svg>\n')
print("wordmark width", w)
