import east_maharashtra as em

# get images that overlap with our AOI
geometry_filter = {
    "type": "GeometryFilter",
        "field_name": "geometry",
            "config": em.geojson_geometry
}

# get images acquired within a date range
date_range_filter = {
    "type": "DateRangeFilter",
        "field_name": "acquired",
            "config": {
"gte": "2017-06-01T00:00:00.000Z",
    "lte": "2017-06-05T00:00:00.000Z"
    }
}

# only get images which have <50% cloud coverage
cloud_cover_filter = {
    "type": "RangeFilter",
        "field_name": "cloud_cover",
            "config": {
"lte": 0.5
}
}

# combine our geo, date, cloud filters
combined_filter = {
    "type": "AndFilter",
        "config": [geometry_filter, date_range_filter, cloud_cover_filter]
}
