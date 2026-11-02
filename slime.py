import numpy as np, math, hashlib, sys, time
from PIL import Image, ImageDraw, ImageFont, ImageFilter

N=600; OUT=1000; SS=2
SYL=['ka','mo','ri','zu','ve','lo','na','thi','bra','sol','xe','pho','dun','mir','gal','tor','ny','qua','fen','ul']
PAL={
 'yolk':[(0,(6,9,8)),(.16,(8,62,60)),(.42,(24,150,120)),(.72,(240,196,60)),(.92,(255,236,170)),(1,(255,255,240))],
 'ember':[(0,(10,6,6)),(.16,(70,10,14)),(.42,(190,40,24)),(.72,(255,140,30)),(.92,(255,214,140)),(1,(255,250,235))],
 'violet':[(0,(7,5,14)),(.16,(40,16,92)),(.42,(120,40,200)),(.72,(240,90,200)),(.92,(255,190,235)),(1,(255,248,255))],
 'toxic':[(0,(5,9,6)),(.16,(10,70,30)),(.42,(60,180,50)),(.72,(200,240,60)),(.92,(240,255,170)),(1,(252,255,238))],
 'aqua':[(0,(4,8,14)),(.16,(8,50,100)),(.42,(20,130,210)),(.72,(70,220,230)),(.92,(190,250,250)),(1,(245,255,255))],
}
def H(*p): return int.from_bytes(hashlib.sha256('|'.join(map(str,p)).encode()).digest()[:8],'big')
def seed_int(tid): return int(hashlib.sha256(f"colony|{tid}|demo-mint-randomness".encode()).hexdigest()[:8],16)
def name_of(tid,edges):
    g=H('name',tid,sorted(edges.items())); out=''
    for i in range(2+(g%2)): out+=SYL[(g>>(5*i+3))%len(SYL)]
    return out.capitalize()
def lut(stops):
    L=np.zeros((256,3),np.float32)
    for i in range(256):
        t=i/255; k=0
        while k<len(stops)-2 and t>stops[k+1][0]: k+=1
        a,b=stops[k],stops[k+1]; u=(t-a[0])/(b[0]-a[0])
        L[i]=[a[1][c]+(b[1][c]-a[1][c])*u for c in range(3)]
    return L
def ring_pos(i,radius):
    a=i/64*2*math.pi-math.pi/2
    return N/2+radius*math.cos(a), N/2+radius*math.sin(a)

def simulate(tid,edges,steps,agents):
    rng=np.random.default_rng(seed_int(tid))
    trail=np.zeros((N,N),np.float32); rad=N*0.33
    R=sum(math.isqrt(d) for d in edges.values())
    nodes=[(N/2,N/2,4.2+min(2.0,R/3500))]
    for nid,D in sorted(edges.items()):
        dn=min(1,D/1e6); x,y=ring_pos(nid,rad*(1-0.5*dn)); nodes.append((x,y,1.6+1.6*dn))
    if not edges: nodes=[(N/2,N/2,1.5)]
    a=rng.uniform(0,2*np.pi,agents); r=np.abs(rng.normal(0,N*0.16,agents)).clip(0,N*0.40)
    x=N/2+np.cos(a)*r; y=N/2+np.sin(a)*r; h=rng.uniform(0,2*np.pi,agents)
    SA,SD,TU,SP=0.6,13.0,0.34,2.4
    def samp(px,py):
        return trail[np.clip(py.astype(np.int32),0,N-1),np.clip(px.astype(np.int32),0,N-1)]
    for s in range(steps):
        for (nx,ny,st) in nodes:
            cx,cy=int(nx),int(ny); y0,y1,x0,x1=max(0,cy-6),min(N,cy+7),max(0,cx-6),min(N,cx+7)
            yy,xx=np.mgrid[y0:y1,x0:x1]; m=((yy-cy)**2+(xx-cx)**2)<=36
            trail[y0:y1,x0:x1]=np.minimum(40,trail[y0:y1,x0:x1]+st*m)
        f=samp(x+np.cos(h)*SD,y+np.sin(h)*SD); l=samp(x+np.cos(h-SA)*SD,y+np.sin(h-SA)*SD); rr=samp(x+np.cos(h+SA)*SD,y+np.sin(h+SA)*SD)
        rand=np.where(rng.random(agents)<0.5,-TU,TU)
        h=h+np.where((f<l)&(f<rr),rand,np.where((l>f)&(l>rr),-TU,np.where((rr>f)&(rr>l),TU,0.0)))
        nx_=x+np.cos(h)*SP; ny_=y+np.sin(h)*SP
        out=((nx_-N/2)**2+(ny_-N/2)**2)>(N*0.42)**2
        nx_=np.where(out,x,nx_); ny_=np.where(out,y,ny_); h=np.where(out,rng.uniform(0,2*np.pi,agents),h)
        x,y=nx_,ny_
        idx=y.astype(np.int32)*N+x.astype(np.int32)
        trail=np.minimum(40,trail+np.bincount(idx,minlength=N*N).reshape(N,N).astype(np.float32))
        p=np.pad(trail,1,mode='edge')
        blur=sum(p[i:i+N,j:j+N] for i in range(3) for j in range(3))/9
        trail=((trail*0.55+blur*0.45)*0.90).astype(np.float32)
    return trail,nodes

def render(tid,edges,epoch,tag,palette='yolk',active=()):
    t0=time.time(); deg=len(edges)
    trail,nodes=simulate(tid,edges,steps=170+25*deg,agents=min(36000,4500+3200*deg))
    L=lut(PAL[palette]); acc=tuple(int(c) for c in PAL[palette][3][1])
    v=np.clip((trail/24.0)**0.8,0,1)
    base=L[(v*255).astype(np.uint8)]
    img=Image.fromarray(base.astype(np.uint8)).resize((OUT,OUT),Image.LANCZOS)
    a=np.asarray(img).astype(np.float32)/255
    bloom=np.asarray(img.filter(ImageFilter.GaussianBlur(11))).astype(np.float32)/255
    a=1-(1-a)*(1-bloom*0.55)                     # screen blend: gentle bloom, crisp core stays
    rng=np.random.default_rng(seed_int(tid)+1)
    a=a+rng.normal(0,0.012,a.shape)              # film grain
    yy,xx=np.mgrid[0:OUT,0:OUT]; rr=np.sqrt((xx-OUT/2)**2+(yy-OUT/2)**2)/(OUT*0.72)
    a=a*np.clip(1.12-rr**2.3,0.2,1.0)[...,None]
    img=Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8)).convert('RGBA')
    S=OUT*SS; lay=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(lay)
    sc=S/N
    ring=N*0.33
    for i in range(64):
        px,py=ring_pos(i,ring)
        if i in edges: continue
        on=i in active; r0=(5 if on else 3)*SS/2
        d.ellipse([px*sc-r0,py*sc-r0,px*sc+r0,py*sc+r0],fill=(*acc,170) if on else (150,160,155,70))
    # dust
    for k in range(140):
        px=rng.uniform(0,S); py=rng.uniform(0,S); r0=rng.uniform(1,3.2)
        d.ellipse([px-r0,py-r0,px+r0,py+r0],fill=(255,255,255,int(rng.uniform(25,90))))
    # neighbour markers
    for (nx,ny,st),nid in (zip(nodes[1:],sorted(edges)) if edges else []):
        dn=min(1,edges[nid]/1e6); cx,cy=nx*sc,ny*sc; r0=(11+8*dn)*SS
        d.ellipse([cx-r0-9*SS,cy-r0-9*SS,cx+r0+9*SS,cy+r0+9*SS],outline=(*acc,90),width=2*SS)
        d.ellipse([cx-r0,cy-r0,cx+r0,cy+r0],outline=(*acc,255),width=3*SS,fill=(6,8,8,200))
        d.ellipse([cx-3.5*SS,cy-3.5*SS,cx+3.5*SS,cy+3.5*SS],fill=(255,250,235,255))
    lay=lay.resize((OUT,OUT),Image.LANCZOS); img=Image.alpha_composite(img,lay)
    # nucleus glow + core
    g=Image.new('RGBA',(OUT,OUT),(0,0,0,0)); gd=ImageDraw.Draw(g); c=OUT/2
    gd.ellipse([c-34,c-34,c+34,c+34],fill=(*acc,200)); g=g.filter(ImageFilter.GaussianBlur(16)); img=Image.alpha_composite(img,g)
    cd=ImageDraw.Draw(img,'RGBA')
    if edges:
        cd.ellipse([c-13,c-13,c+13,c+13],fill=(255,252,240,255)); cd.ellipse([c-20,c-20,c+20,c+20],outline=(255,252,240,200),width=2)
    else:
        cd.ellipse([c-8,c-6,c+8,c+6],fill=(*acc,230))
    # frame and type
    cd.rounded_rectangle([18,18,OUT-18,OUT-18],radius=14,outline=(255,255,255,40),width=2)
    fs=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',40)
    fm=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',18)
    R=sum(math.isqrt(x) for x in edges.values()); nm=name_of(tid,edges) if edges else 'dormant'
    cd.text((54,46),f"#{tid:04d}",font=fs,fill=(240,236,220,240))
    cd.text((54,OUT-100),nm,font=fs,fill=(240,236,220,245))
    cd.text((OUT-54,OUT-90),f"epoch {epoch}",font=fm,fill=(*acc,235),anchor='ra')
    cd.text((OUT-54,OUT-62),f"degree {deg} · rep {R/1000:.1f}",font=fm,fill=(190,200,195,235),anchor='ra')
    img.convert('RGB').save(f'v2-{tag}.png')
    print(tag,nm,palette,round(time.time()-t0,1),'s',flush=True)

active={3,7,12,19,24,28,33,35,41,46,52,58,61,9,15,22}
def nb(tid,k):
    out={}; i=0
    while len(out)<k:
        n=H('nb',tid,i)%64; i+=1
        if n!=tid and n not in out: out[n]=int(250000+(H('d',tid,n)%750000))
    return out
PRESETS={
 'mature':(7,{3:880000,12:430000,19:990000,28:260000,35:670000,41:510000,52:340000,58:150000},41,'yolk'),
 'young':(7,{19:240000,35:160000},6,'yolk'),
 'spore':(7,{},0,'yolk'),
 'ember':(12,nb(12,6),29,'ember'),
 'violet':(23,nb(23,9),52,'violet'),
 'toxic':(41,nb(41,5),17,'toxic'),
 'aqua':(58,nb(58,8),38,'aqua'),
}
for tag in sys.argv[1:]:
    tid,e,ep,pal=PRESETS[tag]; render(tid,e,ep,tag,pal,active)
