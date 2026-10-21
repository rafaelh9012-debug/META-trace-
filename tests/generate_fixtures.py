"""Generate tiny synthetic images. Tests do not contain anyone's photographs."""
from pathlib import Path
import struct
from PIL import Image,TiffImagePlugin
p=Path(__file__).resolve().parent/'fixtures';p.mkdir(exist_ok=True)
R=TiffImagePlugin.IFDRational
image=Image.new('RGB',(32,24),(88,20,46))
def gps(lat=(29,38,55.87),lon=(82,20,16.4),latref='N',lonref='W',alt=47.46,altref=0,hpe=None):
 d={2:tuple(R(x) for x in lat),4:tuple(R(x) for x in lon)}
 if hpe is not None:d[31]=R(hpe)
 if latref is not None:d[1]=latref
 if lonref is not None:d[3]=lonref
 if alt is not None:d[5]=altref;d[6]=R(alt)
 return d
def metadata(g):
 e=Image.Exif();e[271]='Synthetic Test Camera';e[272]='Fixture 1';e[34853]=g;e[34665]={36867:'2026:10:21 12:34:56',36881:'-04:00'};return e
for name,g in [('gps-north-west.jpg',gps()),('gps-south-east.jpg',gps(latref='S',lonref='E',alt=12.5,altref=1)),('gps-zero-zero.jpg',gps(lat=(0,0,0),lon=(0,0,0),alt=0)),('gps-outside-region.jpg',gps(lat=(48,51,29.52),lon=(2,17,40.2),lonref='E')),('partial-gps.jpg',{1:'N',2:(R(29),R(38),R(55.87))}),('missing-ref.jpg',gps(latref=None)),('invalid-gps.jpg',gps(lat=(91,0,0)))]:image.save(p/name,exif=metadata(g))
image.save(p/'no-gps.jpg');image.save(p/'no-gps.png');image.save(p/'gps.png',exif=metadata(gps()))
tiff_exif=Image.Exif();tiff_exif.load(metadata(gps()).tobytes());image.save(p/'gps.tiff',exif=tiff_exif)
image.save(p/'gps.webp',format='WEBP',exif=metadata(gps()).tobytes());image.save(p/'no-gps.webp',format='WEBP')
(p/'unsupported.bin').write_bytes(b'%PDF-1.7\nnot an image');(p/'corrupt.tiff').write_bytes(b'II*\x00\xff\xff\xff\xff');(p/'empty.jpg').write_bytes(b'')
xmp=b'''<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.492N" exif:GPSLongitude="2,17.670E"/></rdf:RDF></x:xmpmeta>'''
segment=b'http://ns.adobe.com/xap/1.0/\0'+xmp
app1=b'\xff\xe1'+struct.pack('>H',len(segment)+2)+segment
base=(p/'no-gps.jpg').read_bytes();(p/'xmp-gps.jpg').write_bytes(base[:2]+app1+base[2:])
base=(p/'gps-north-west.jpg').read_bytes();(p/'conflicting-gps.jpg').write_bytes(base[:2]+app1+base[2:])
b=bytearray((p/'gps.webp').read_bytes());b[4:8]=struct.pack('<I',len(b)+500);(p/'corrupt.webp').write_bytes(b)
# --- additions for the cinematic upgrade (v2.1) ---------------------------------
# A larger synthetic picture so the preview, scan sweep and screenshots have something to show.
from PIL import ImageDraw
def scene(width=1200,height=800):
 img=Image.new('RGB',(width,height));px=img.load()
 for y in range(height):
  t=y/height
  for x in range(width):px[x,y]=(int(36+150*(1-t)**1.6+20*x/width),int(18+46*(1-t)),int(40+60*(1-t)))
 d=ImageDraw.Draw(img);d.ellipse((width*.68,height*.12,width*.68+150,height*.12+150),fill=(244,170,140))
 for i,(x,w,h) in enumerate([(40,150,300),(210,110,220),(340,190,360),(560,120,250),(700,170,310),(900,130,200),(1050,110,330)]):
  d.rectangle((x,height-h-60,x+w,height-60),fill=(26+i*3,14,24));
  for wy in range(height-h-40,height-90,46):
   for wx in range(x+14,x+w-18,34):d.rectangle((wx,wy,wx+14,wy+22),fill=(196,98,120) if (wx+wy)%3 else (70,34,52))
 d.rectangle((0,height-60,width,height),fill=(18,10,18));return img
big=scene()
def with_gps(name,g,img=big):img.save(p/name,quality=88,exif=metadata(g))
# Gainesville, with a recorded horizontal positioning error: finishes on real street geometry.
with_gps('sample-street.jpg',gps(hpe=12.5))
# The handoff's own example. It lies outside the bundled street data, so it finishes on the world overview.
with_gps('handoff-overview.jpg',gps(lat=(34,12,16.2972),lon=(89,16,59.6532),lonref='E',alt=47.46,hpe=12.5))
# Longitude wrapping: both sit about 11 m from the antimeridian, on opposite sides.
with_gps('gps-antimeridian-east.jpg',gps(lat=(17,45,0),lon=(179,59,59.64),latref='S',lonref='E'),image)
with_gps('gps-antimeridian-west.jpg',gps(lat=(17,45,0),lon=(179,59,59.64),latref='S',lonref='W'),image)
# Projection limit: 85.0 degrees is displayable, 89.5 is not.
with_gps('gps-lat-85.jpg',gps(lat=(85,0,0),lon=(10,0,0),lonref='E'),image)
with_gps('gps-near-pole.jpg',gps(lat=(89,30,0),lon=(45,0,0),lonref='E'),image)
with_gps('gps-south-pole.jpg',gps(lat=(89,30,0),lon=(45,0,0),latref='S',lonref='W'),image)
(p/'README.txt').write_text('All images are generated colored rectangles containing synthetic metadata. Coordinates are test values, not the location of a photographed person. Run generate_fixtures.py with Pillow only when regenerating these files. Running the application requires no Python packages.\n')
print('Generated',len(list(p.glob('*'))),'fixture files.')
