# Radar boundary texture

`public/globe/earth-radar-boundaries.png` uses the existing `earth-radar-light.jpg` base without changing its land/ocean colors, with pale pink political boundary lines added from Natural Earth:

- https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_admin_0_boundary_lines_land.geojson
- https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_1_states_provinces_lines.geojson
- License: https://www.naturalearthdata.com/about/terms-of-use/

Natural Earth data is public domain. Political boundaries reflect that source's cartographic representation, not a new statement about sovereignty. Country lines use RGB 216/158/170, state/province lines 225/190/195. Lines are drawn at 3x size and downsampled to the original 2048x1024 equirectangular projection. Dateline-crossing segments are not drawn across the entire image. The texture is shared by the light globe and flat map. Other globe styles are unchanged.
