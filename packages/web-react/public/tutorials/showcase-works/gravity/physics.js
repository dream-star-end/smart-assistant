(()=>{
// Original dimensionless softened Newtonian model. Velocity Verlet, not a collision solver.
const EPSILON=.025, DT=.002;
function initial(preset='eight'){
let b=preset==='eight'?[{x:-.97000436,y:.24308753,vx:.466203685,vy:.43236573,m:1},{x:.97000436,y:-.24308753,vx:.466203685,vy:.43236573,m:1},{x:0,y:0,vx:-.93240737,vy:-.86473146,m:1}]:preset==='orbit'?[{x:0,y:0,vx:0,vy:-.18,m:2},{x:1.2,y:0,vx:0,vy:1.1,m:.35},{x:-1.8,y:0,vx:0,vy:-.8,m:.18}]:[{x:-1,y:-.35,vx:.2,vy:.45,m:1},{x:1,y:.15,vx:-.25,vy:-.55,m:1.3},{x:.2,y:1.3,vx:.05,vy:-.1,m:.7}];
const M=b.reduce((s,p)=>s+p.m,0),cx=b.reduce((s,p)=>s+p.x*p.m,0)/M,cy=b.reduce((s,p)=>s+p.y*p.m,0)/M,vx=b.reduce((s,p)=>s+p.vx*p.m,0)/M,vy=b.reduce((s,p)=>s+p.vy*p.m,0)/M;
return b.map(p=>({...p,x:p.x-cx,y:p.y-cy,vx:p.vx-vx,vy:p.vy-vy}));
}
function acceleration(b){const a=b.map(()=>({x:0,y:0}));for(let i=0;i<b.length;i++)for(let j=i+1;j<b.length;j++){const dx=b[j].x-b[i].x,dy=b[j].y-b[i].y,den=(dx*dx+dy*dy+EPSILON*EPSILON)**1.5;a[i].x+=b[j].m*dx/den;a[i].y+=b[j].m*dy/den;a[j].x-=b[i].m*dx/den;a[j].y-=b[i].m*dy/den;}return a;}
function step(b,dt=DT){const a=acceleration(b);b.forEach((p,i)=>{p.x+=p.vx*dt+.5*a[i].x*dt*dt;p.y+=p.vy*dt+.5*a[i].y*dt*dt;});const next=acceleration(b);b.forEach((p,i)=>{p.vx+=.5*(a[i].x+next[i].x)*dt;p.vy+=.5*(a[i].y+next[i].y)*dt;});return b;}
function measure(b){let energy=0,px=0,py=0;b.forEach((p,i)=>{energy+=.5*p.m*(p.vx*p.vx+p.vy*p.vy);px+=p.m*p.vx;py+=p.m*p.vy;for(let j=i+1;j<b.length;j++)energy-=p.m*b[j].m/Math.sqrt((p.x-b[j].x)**2+(p.y-b[j].y)**2+EPSILON**2);});return {energy,px,py};}

window.GravityPhysics={initial,step,measure,DT,EPSILON};})();
