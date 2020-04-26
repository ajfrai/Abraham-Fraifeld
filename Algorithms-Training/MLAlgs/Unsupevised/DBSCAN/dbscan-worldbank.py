#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun Apr 26 19:53:10 2020

@author: fraifeld-mba
"""

from DBSCAN import DBSCANNer
import pandas as pd

data = pd.read_csv("2.12_Health_systems.csv")
data = data.drop(columns=["Completeness_of_death_reg_2008-16","Province_State","Country_Region"])
data = data.dropna().reset_index(drop=True)


clusterer = DBSCANNer(data)
clusterer.plot_kdist_graph()
clusterer.DBSCAN(700)
clusterer.plot_clusters("World Bank - Health System Quality Clusters\nEps = 700")