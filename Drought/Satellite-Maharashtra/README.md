# Project Explanation

In this directory, I am storing progress on tutorials that help me learn about satellite data/remote sensing/computer vision with a specific focus on Maharashtra India.

## Progress so far

[Used this tutorial](https://medium.com/analytics-vidhya/satellite-imagery-analysis-with-python-3f8ccf8a7c32) to pull data from Planet.com and calculate/visualize the normalized difference vegitation index for East Maharashtra.

Still working on learning about the data collection process (can I issue a single request that gets me all images for a certain time range?) 

## Instructions

### east_maharashtra.py is 
A helper file. It defines the coordinates for the area to be analyzed

### filters.py

A file that stores filters to be passed to Planet.com for data collection. These should be modified to get different dates / otherwise different data.

### collect_bands.py

A file that searches Planet.com based on the filters in filters.py

### activate.py

Planet.com requires that resources be activated before downloading them. This script activates the resources found in collect_bands.py

### explore-satellite-data.py

Once the .tif file has been downloaded, this file will calculate the Normalized Difference Vegitation Index for the area the image represents. It will then create two visualizations - a map of the area with pixels colored according to their NDVI and an NDVI histogram. 
