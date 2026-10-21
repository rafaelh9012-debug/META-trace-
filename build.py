"""Build the self-contained offline demo. No packages required."""
from pathlib import Path
import json
import re
ROOT=Path(__file__).resolve().parent

def main():
    from map_builder import build_map
    geo,labels,meta=build_map(ROOT)
    data='window.TRACE_MAP_DATA='+json.dumps(geo,separators=(',',':'))+';\nwindow.TRACE_MAP_LABELS='+json.dumps(labels,separators=(',',':'))+';\nwindow.TRACE_MAP_META='+json.dumps(meta,separators=(',',':'))+';'
    html=(ROOT/'template.html').read_text()
    replacements={'/*__LEAFLET_CSS__*/':(ROOT/'vendor/leaflet.css').read_text(),'/*__APP_CSS__*/':(ROOT/'styles.css').read_text(),'/*__LEAFLET_JS__*/':(ROOT/'vendor/leaflet.js').read_text(),'/*__MAP_DATA__*/':data,'/*__CORE_JS__*/':(ROOT/'core.js').read_text(),'/*__APP_JS__*/':(ROOT/'app.js').read_text()}
    for token,value in replacements.items():html=html.replace(token,value)
    assert not re.search(r'/\*__\w+__\*/',html)
    (ROOT/'Qwen_Map_Console.html').write_text(html,encoding='utf-8')
    (ROOT/'data/map-data.json').write_text(json.dumps(geo,separators=(',',':')))
    (ROOT/'data/map-labels.json').write_text(json.dumps(labels,separators=(',',':')))
    (ROOT/'data/map-meta.json').write_text(json.dumps(meta,indent=2))
    print('Built Qwen_Map_Console.html:',len(html.encode()),'bytes;',len(geo['features']),'map features')

if __name__=='__main__':main()
