"""Turn the supplied public OSM extract into a detailed offline vector map."""
from pathlib import Path
import collections
import math
import re
import xml.etree.ElementTree as ET

TARGET=(-82.33788888888888,29.648852777777776)

def tags(el):return {t.get('k'):t.get('v') for t in el.findall('tag')}

def distance(a,b):
    return math.hypot((a[0]-b[0])*math.cos(math.radians(a[1]))*111320,(a[1]-b[1])*111320)

def short_name(name):
    for a,b in [('Southwest ','SW '),('Northwest ','NW '),('Southeast ','SE '),('Northeast ','NE '),('West ','W '),('East ','E '),(' Avenue',' Ave'),(' Street',' St'),(' Terrace',' Terr'),(' Drive',' Dr'),(' Boulevard',' Blvd')]:name=name.replace(a,b)
    return name

def ring_center(ring):
    area=cx=cy=0
    for a,b in zip(ring,ring[1:]):
        cross=a[0]*b[1]-b[0]*a[1];area+=cross;cx+=(a[0]+b[0])*cross;cy+=(a[1]+b[1])*cross
    if abs(area)>1e-14:return [cx/(3*area),cy/(3*area)]
    return [sum(p[0] for p in ring)/len(ring),sum(p[1] for p in ring)/len(ring)]

def contains(point,ring):
    x,y=point;inside=False
    for a,b in zip(ring,ring[1:]):
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:inside=not inside
    return inside

def stitch(chains):
    chains=[c[:] for c in chains if len(c)>1];out=[]
    while chains:
        c=chains.pop(0);changed=True
        while c[0]!=c[-1] and changed:
            changed=False
            for i,d in enumerate(chains):
                if c[-1]==d[0]:c+=d[1:]
                elif c[-1]==d[-1]:c+=list(reversed(d))[1:]
                elif c[0]==d[-1]:c=d[:-1]+c
                elif c[0]==d[0]:c=list(reversed(d))[:-1]+c
                else:continue
                chains.pop(i);changed=True;break
        if len(c)>3 and c[0]==c[-1]:out.append(c)
    return out

def build_map(directory):
    parts=[directory/'data'/f'part-{i}.osm' for i in range(4)]
    if all(p.exists() for p in parts):
        root=ET.Element('osm')
        ET.SubElement(root,'bounds',{'minlon':'-82.351','minlat':'29.638','maxlon':'-82.324','maxlat':'29.659'})
        elements={}
        for part in parts:
            for el in ET.parse(part).getroot():
                if el.tag in ('node','way','relation'):elements[(el.tag,el.get('id'))]=el
        root.extend(elements.values());source_name='part-0.osm through part-3.osm'
    else:
        root=ET.parse(directory/'data/area.osm').getroot();source_name='area.osm'
    bounds_el=root.find('bounds')
    bounds=[float(bounds_el.get(k)) for k in ('minlon','minlat','maxlon','maxlat')] if bounds_el is not None else [-82.346,29.642,-82.329,29.656]
    nodes={n.get('id'):[round(float(n.get('lon')),7),round(float(n.get('lat')),7)] for n in root.findall('node')}
    ways={w.get('id'):w for w in root.findall('way')}
    def coords(w):return [nodes[n.get('ref')] for n in w.findall('nd') if n.get('ref') in nodes]
    features=[];labels=[];seen_labels=set();relation_members=set();road_samples=collections.defaultdict(list)
    def label(text,point,kind,priority,minzoom,angle=0,symbol=''):
        if not text or len(text)>90:return
        key=(text,round(point[0],5),round(point[1],5))
        if key in seen_labels:return
        seen_labels.add(key)
        labels.append({'text':short_name(text),'lon':round(point[0],7),'lat':round(point[1],7),'kind':kind,'priority':priority,'minZoom':minzoom,'angle':round(angle,1),'symbol':symbol})
    def add(kind,geometry,props=None):
        p={'kind':kind};p.update(props or {})
        features.append({'type':'Feature','geometry':geometry,'properties':p})
    def polygon_kind(t):
        if t.get('building'):return 'building'
        if t.get('natural')=='water' or t.get('leisure')=='swimming_pool' or t.get('water'):return 'water'
        if t.get('amenity') in ('parking','parking_space') or t.get('parking'):return 'parking'
        if t.get('landuse') in ('grass','forest','meadow','recreation_ground') or t.get('leisure') in ('park','garden','pitch') or t.get('natural') in ('wood','scrub','grassland'):return 'green'
        if t.get('highway') in ('pedestrian','footway') or t.get('surface') in ('paving_stones','concrete','asphalt'):return 'paved'
        return None
    def polygon_props(t):
        props={}
        if t.get('name'):props['name']=t['name']
        if t.get('building:levels'):props['levels']=t['building:levels']
        if t.get('leisure')=='swimming_pool':props['pool']=True
        if 'Courtyards' in t.get('name',''):props['highlight']=True
        return props
    def area_label(t,xy,kind):
        name=t.get('name')
        if name:
            c=ring_center(xy);priority=5 if 'Courtyards' in name else 14
            label(name,c,'building' if kind=='building' else 'place',priority,17 if kind=='building' else 16)
        if kind=='parking':label('Parking',ring_center(xy),'parking',40,18,symbol='P')
    # Keep actual inner rings: pools, gardens and courtyards remain visible.
    for rel in root.findall('relation'):
        t=tags(rel);kind=polygon_kind(t)
        if not kind or t.get('type')!='multipolygon':continue
        chains={'outer':[],'inner':[]}
        members=[]
        for m in rel.findall('member'):
            if m.get('type')!='way' or m.get('ref') not in ways:continue
            role=m.get('role') or 'outer'
            if role in chains:chains[role].append(coords(ways[m.get('ref')]));members.append(m.get('ref'))
        outers=stitch(chains['outer']);inners=stitch(chains['inner'])
        if not outers:continue
        relation_members.update(members)
        for outer in outers:
            rings=[outer]+[hole for hole in inners if contains(hole[0],outer)]
            add(kind,{'type':'Polygon','coordinates':rings},polygon_props(t));area_label(t,outer,kind)
    for ref,w in ways.items():
        t=tags(w);xy=coords(w)
        if len(xy)<2:continue
        closed=len(xy)>3 and xy[0]==xy[-1]
        if closed:
            kind=polygon_kind(t)
            if kind and ref not in relation_members:
                add(kind,{'type':'Polygon','coordinates':[xy]},polygon_props(t));area_label(t,xy,kind)
        if t.get('highway') and t.get('area')!='yes':
            props={k:t[k] for k in ('highway','name','oneway','service','surface','bridge','tunnel','lanes') if k in t}
            add('road',{'type':'LineString','coordinates':xy},props)
            name=t.get('name');highway=t['highway']
            if name:
                major=highway in ('primary','secondary','tertiary','trunk')
                minor=highway in ('footway','path','cycleway','steps','pedestrian')
                road_samples[name].append((xy,16 if major else 19 if minor else 17,7 if major else 18))
        elif t.get('barrier') in ('fence','wall','hedge','retaining_wall'):
            add('barrier',{'type':'LineString','coordinates':xy},{'type':t['barrier']})
    for name,segments in road_samples.items():
        placed=[]
        for xy,minzoom,priority in segments:
            walked=100
            for a,b in zip(xy,xy[1:]):
                walked+=distance(a,b)
                if walked<130:continue
                p=[(a[0]+b[0])/2,(a[1]+b[1])/2]
                if any(distance(p,q)<145 for q in placed):continue
                angle=math.degrees(math.atan2(-(b[1]-a[1]),(b[0]-a[0])*math.cos(math.radians(p[1]))))
                if angle>90:angle-=180
                if angle<-90:angle+=180
                label(name,p,'road',priority,minzoom,angle);placed.append(p);walked=0
    amenities={'restaurant':'food','fast_food':'food','cafe':'cafe','pharmacy':'medical','hospital':'medical','clinic':'medical','library':'library','college':'education','university':'education','school':'education','bank':'bank','atm':'bank','fuel':'fuel','place_of_worship':'place','cinema':'place','bicycle_rental':'bike','parking':'parking','parking_entrance':'parking'}
    for n in root.findall('node'):
        t=tags(n);point=nodes[n.get('id')]
        if not (bounds[0]<=point[0]<=bounds[2] and bounds[1]<=point[1]<=bounds[3]):continue
        if t.get('natural')=='tree':add('tree',{'type':'Point','coordinates':point})
        elif t.get('amenity') in ('bench','bicycle_parking','waste_basket','drinking_water','fountain') or t.get('highway') in ('street_lamp','crossing'):
            add('furniture',{'type':'Point','coordinates':point},{'type':t.get('amenity',t.get('highway'))})
        kind=amenities.get(t.get('amenity')) or ('shop' if t.get('shop') else None)
        if kind:
            add('poi',{'type':'Point','coordinates':point},{'type':kind})
            if t.get('name'):label(t['name'],point,'poi',10,17,symbol={'food':'•','medical':'+','parking':'P','bike':'B'}.get(kind,'•'))
        elif t.get('highway')=='bus_stop':
            add('bus',{'type':'Point','coordinates':point})
            if t.get('name'):label(t['name'],point,'bus',35,19,symbol='B')
    counts=dict(collections.Counter(f['properties']['kind'] for f in features))
    meta={'bounds':bounds,'features':len(features),'labels':len(labels),'counts':counts,'source':source_name,'dataDate':'2026-10-16'}
    return {'type':'FeatureCollection','features':features},labels,meta
