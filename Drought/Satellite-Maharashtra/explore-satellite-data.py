#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May  6 14:27:21 2019

@author: fraifeld-mba
"""

import math
import rasterio
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import colors

path = '/users/fraifeld-mba/desktop/Satellite-Maharashtra/bin/data/EastMaharashtra/'

image_file = path + 'east_maharashtra.tif'

def calculate_ndvi(image_file): # Normalized Difference Vegetation Index .. calcualtes vegitation density in a given area
    # This is a function of reflected near infared light and visible red light. The more visible red light, the lower the vegitation density
    
    ## First, extract the near-infared and visible red light from the image file
    
    with rasterio.open(image_file) as src:
        band_red = src.read(3)
    with rasterio.open(image_file) as src:
        band_nir = src.read(4)
    
    ## Ensure that the program does not crash by ignoring division by zero 
    
    np.seterr(divide='ignore', invalid='ignore')

    ## Calculate ndvi, which is (near infared - visible red) / (near infared + red)
    print("Calculating NDVI...")
    ndvi = (band_nir.astype(float) - band_red.astype(float)) / (band_nir + band_red)
    
    # Minimum ndvi pixel
    print("MIN: " + str(np.nanmin(ndvi))) 
    
    # Maximum ndvi pixel
    
    print("MAX: " + str(np.nanmax(ndvi)))
    
    return ndvi

def save_NDVI_image(image_file,ndvi):
    with rasterio.open(image_file) as src:
        meta = src.meta
        
    # Make sure the ndvi and file matrix data types match. This ensures a clean write
    ndvi_dtype = ndvi.dtype
    kwargs = meta #key word arguments. makes dictionaries easier to use.
    kwargs.update(dtype=ndvi_dtype)
    kwargs.update(count=1)
    with rasterio.open(path+'ndvi.tif', 'w', **kwargs) as dst:
        dst.write(ndvi, 1)
   

class MidpointNormalize(colors.Normalize):
    
    def __init__(self, vmin=None, vmax=None, midpoint=None, clip=False):
        # Constroctor. set the midpoint and normalize the colors using that midpoint
        self.midpoint = midpoint
        colors.Normalize.__init__(self, vmin, vmax, clip)
        
    def __call__(self, value, clip=None):
        # defines a function MidpointNormalize
       
        x, y = [self.vmin, self.midpoint, self.vmax], [0, 0.5, 1]
        return np.ma.masked_array(np.interp(value, x, y), np.isnan(value)) # masked arrays are like arrays but they provide work arounds for missing values
    
def visualize_NDVI(ndvi):
    print("Generating map of NDVI values...")
    minimum=np.nanmin(ndvi)
    maximum=np.nanmax(ndvi)
    
    # set out custom midpoint for visualization purposes
    mid=0.1
    
    # create a colormap. normalize the colormap according to our midpoint
    colormap = plt.cm.RdYlGn 
    norm = MidpointNormalize(vmin=minimum, vmax=maximum, midpoint=mid)
    fig = plt.figure(figsize=(20,10))
    ax = fig.add_subplot(111)

    # Use 'imshow' to specify the input data, colormap, min, max, and norm for the colorbar
    cbar_plot = ax.imshow(ndvi, cmap=colormap, vmin=minimum, vmax=maximum, norm=norm)
   
    # turn off axis display
    
    ax.axis('off')
    
    
    # Set axis title
    ax.set_title('Normalized Difference Vegetation Index - East Maharashtra', fontsize=17, fontweight='bold')

    # configure the color bar according to the above cbar_plot variable, which took as input the ndvi min and max
    
    cbar = fig.colorbar(cbar_plot, orientation='horizontal', shrink=0.65)

    # save the plot
    fig.savefig(path+'output/ndvi-image.png', dpi=200, bbox_inches='tight', pad_inches=0.7)
    
    #plt.show()

def histogram_NDVI(ndvi):
    print("Generating histogram...")
    fig2 = plt.figure(figsize=(20,10))

    # Give this new figure a subplot, which will contain the histogram itself
    ax = fig2.add_subplot(111)
    
    
    plt.title("NDVI Histogram - East Maharashtra", fontsize=18, fontweight='bold')
    
    # The x axis will refer to ndvi values and the y axis will refer to the number of pixels with a given ndvi valu

    plt.xlabel("NDVI values", fontsize=14)
    plt.ylabel("Number of pixels", fontsize=14)
    
    # eliminate missing values
    x = ndvi[~np.isnan(ndvi)]


    # Let the color be green. create 30 a 30 bin bar graph using our x axis data
    color = 'g'
    ax.hist(x,bins=30,color=color,histtype='bar', ec='black')

    fig2.savefig(path+"output/ndvi-histogram.png", dpi=200, bbox_inches='tight', pad_inches=0.5)


    #plt.show()

    
if __name__ == "__main__":
    ndvi = calculate_ndvi(image_file)
    save_NDVI_image(image_file,ndvi)
    visualize_NDVI(ndvi)
    histogram_NDVI(ndvi)
    
    
    


        
        

